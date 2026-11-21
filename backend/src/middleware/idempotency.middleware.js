const crypto = require('crypto');
const { client } = require('../config/redis');
const audit = require('../services/audit.service');
const logger = require('../utils/logger');

/**
 * Idempotency Middleware for Stellarcade API
 *
 * Enforces idempotent behavior on mutation requests by reserving the key
 * atomically before the handler runs and replaying successful responses.
 *
 * ## How It Works
 * 1. Client generates a unique key (UUID recommended) per operation
 * 2. Middleware hashes the request body and atomically reserves
 *    `idempotency:{userId}:{clientKey}` with Redis `SET NX` before `next()`
 * 3. Only the reserving request enters the handler; a concurrent duplicate
 *    with the same payload gets `409 Idempotency In Progress` instead of
 *    running the side effect twice
 * 4. On success the reservation is replaced with the cached response; a
 *    non-2xx response releases the reservation so the client can retry
 * 5. On duplicate key, verifies the body hash matches the original
 * 6. If match: replays cached response (idempotent)
 * 7. If mismatch: returns 409 Conflict (key reuse detected)
 *
 * ## Redis Key Schema
 * `idempotency:{userId}:{clientKey}`
 *
 * ## Cache Behavior
 * - Only caches 2xx (successful) responses
 * - Completed TTL: 24 hours
 * - Pending (in-flight) TTL: IDEMPOTENCY_PENDING_TTL_SECONDS (default 60)
 *
 * ## Ownership
 * Every reservation carries an owner token. Finalization and release are
 * compare-and-set operations guarded by that exact stored value, so an owner
 * whose reservation expired and was taken over can never overwrite or delete
 * the newer owner's reservation.
 *
 * ## When to Use
 * - REQUIRED: Wallet operations (deposit, withdraw)
 * - OPTIONAL: Game plays (prevents accidental double-plays)
 * - NOT USED: GET/HEAD/OPTIONS (inherently idempotent)
 *
 * @example
 * // Client usage example
 * fetch('/api/wallet/withdraw', {
 *   method: 'POST',
 *   headers: {
 *     'Authorization': 'Bearer <token>',
 *     'Idempotency-Key': '550e8400-e29b-41d4-a716-446655440000'
 *   },
 *   body: JSON.stringify({ amount: 100, address: 'G...' })
 * });
 *
 * @see {@link ../../docs/API_DOCUMENTATION.md#idempotency} for full API documentation
 * @see {@link ../../frontend/src/services/idempotency-transaction-handling.README.md} for frontend integration
 */

// How long a completed response is replayed.
const COMPLETED_TTL_SECONDS = 24 * 60 * 60;
// How long an in-flight reservation is treated as live before another request
// may take it over. Must comfortably exceed the slowest handler.
const DEFAULT_PENDING_TTL_SECONDS = 60;
// The reservation key is kept for twice the logical lease. The extra window
// lets a crashed owner's marker survive long enough for a new request to take
// it over atomically instead of racing a bare expiry.
const RESERVATION_TTL_MULTIPLIER = 2;
// Bounded retries when a reservation expires between SET NX and GET.
const MAX_RESERVE_ATTEMPTS = 3;

/**
 * Compare-and-set/delete on the reservation key, guarded by its exact stored
 * value (which embeds the owner token).
 *
 * KEYS[1] = reservation key
 * ARGV[1] = expected stored value
 * ARGV[2] = new stored value (ignored when ARGV[4] is 'delete')
 * ARGV[3] = new TTL in seconds (ignored when ARGV[4] is 'delete')
 * ARGV[4] = 'set' or 'delete'
 *
 * Returns 1 when the key matched and was changed, 0 otherwise.
 */
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then
  return 0
end
if ARGV[4] == 'delete' then
  redis.call('DEL', KEYS[1])
  return 1
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

const stableStringify = (value) => JSON.stringify(audit.normalizeValue(value));

const buildFingerprint = (req) =>
  crypto
    .createHash('sha256')
    .update(
      stableStringify({
        method: req.method,
        path: req.originalUrl || req.path,
        body: req.body || {},
      })
    )
    .digest('hex');

const duplicateMetadata = (req, key, fingerprint, extra = {}) => ({
  idempotencyKey: key,
  fingerprint,
  method: req.method,
  path: req.originalUrl || req.path,
  userId: req.user ? String(req.user.id) : 'anonymous',
  request: audit.redactSensitive(req.body || {}),
  ...extra,
});

/** Logical lease length for an in-flight reservation, in seconds. */
const pendingTtlSeconds = () => {
  const configured = Number(process.env.IDEMPOTENCY_PENDING_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PENDING_TTL_SECONDS;
};

const pendingValue = (fingerprint, token) =>
  JSON.stringify({
    state: 'pending',
    requestFingerprint: fingerprint,
    token,
    startedAt: Date.now(),
  });

const completedValue = (fingerprint, statusCode, body) =>
  JSON.stringify({
    state: 'completed',
    requestFingerprint: fingerprint,
    statusCode,
    body,
  });

const parseRecord = (raw) => {
  try {
    const record = JSON.parse(raw);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
};

// Records written before this change have no `state` but carry a status code.
const isCompleted = (record) =>
  record.state === 'completed' || (record.state === undefined && record.statusCode !== undefined);

const casSet = (redisKey, expected, next, ttlSeconds) =>
  client.eval(CAS_SCRIPT, {
    keys: [redisKey],
    arguments: [expected, next, String(ttlSeconds), 'set'],
  });

const casDelete = (redisKey, expected) =>
  client.eval(CAS_SCRIPT, {
    keys: [redisKey],
    arguments: [expected, '', '0', 'delete'],
  });

/**
 * Atomically reserves the key for this request, or classifies the existing
 * reservation.
 *
 * @returns {Promise<
 *   {type: 'owned', value: string} |
 *   {type: 'completed', record: object} |
 *   {type: 'conflict'} |
 *   {type: 'in-progress'}
 * >}
 */
const reserve = async (redisKey, fingerprint, token, pendingTtl) => {
  const reservationTtl = pendingTtl * RESERVATION_TTL_MULTIPLIER;

  for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt += 1) {
    const value = pendingValue(fingerprint, token);
    const stored = await client.set(redisKey, value, { NX: true, EX: reservationTtl });
    if (stored === 'OK') {
      return { type: 'owned', value };
    }

    const raw = await client.get(redisKey);
    if (!raw) {
      continue; // Reservation expired between SET NX and GET; try again.
    }

    const record = parseRecord(raw);
    if (!record) {
      // A value we did not write: refuse to clobber it.
      return { type: 'conflict' };
    }

    if (isCompleted(record)) {
      return { type: 'completed', record };
    }

    if (record.requestFingerprint !== fingerprint) {
      return { type: 'conflict' };
    }

    // Same payload, still pending. Take over only if the owner is stale.
    const ageMs = Date.now() - (Number(record.startedAt) || 0);
    if (ageMs > pendingTtl * 1000) {
      const takeover = pendingValue(fingerprint, token);
      const taken = await casSet(redisKey, raw, takeover, reservationTtl);
      if (taken) {
        return { type: 'owned', value: takeover };
      }
    }
    return { type: 'in-progress' };
  }

  // The key kept expiring under us. Fail open rather than block the client; a
  // completion CAS below will simply not match, so nothing is cached.
  return { type: 'owned', value: pendingValue(fingerprint, token) };
};

const idempotency = async (req, res, next) => {
  const key = req.header('Idempotency-Key');

  // Skip if no idempotency key or if it's not a mutation/side-effect method.
  // GET, HEAD, OPTIONS are inherently idempotent and don't need caching
  if (!key || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Redis Key Schema: idempotency:{userId}:{clientKey}
  // Scoped to user to prevent cross-user key collisions
  const userId = req.user ? req.user.id : 'anonymous';
  const redisKey = `idempotency:${userId}:${key}`;
  const pendingTtl = pendingTtlSeconds();
  const fingerprint = buildFingerprint(req);
  const token = crypto.randomUUID();

  let outcome;
  try {
    outcome = await reserve(redisKey, fingerprint, token, pendingTtl);
  } catch (error) {
    logger.error('[Idempotency] Middleware internal error:', error);
    // In case of Redis failure, we proceed with the request to avoid blocking users
    // This is a fail-open design: better to allow duplicates than block legitimate requests
    return next();
  }

  if (outcome.type === 'completed') {
    if (outcome.record.requestFingerprint !== fingerprint) {
      audit.log({
        actor: userId,
        action: 'idempotency.conflict',
        target: redisKey,
        payload: { idempotencyKey: key, fingerprint },
        outcome: 'failure',
        metadata: duplicateMetadata(req, key, fingerprint, {
          cachedFingerprint: outcome.record.requestFingerprint,
          replayed: false,
        }),
      });
      return res.status(409).json({
        error: 'Idempotency Conflict',
        message:
          'The provided Idempotency-Key was already used with a different request payload.',
      });
    }

    logger.info(`[Idempotency] Replaying cached response for key: ${key}`);
    audit.log({
      actor: userId,
      action: 'idempotency.replay',
      target: redisKey,
      payload: { idempotencyKey: key, fingerprint },
      outcome: 'success',
      metadata: duplicateMetadata(req, key, fingerprint, {
        cachedStatusCode: outcome.record.statusCode,
        replayed: true,
      }),
    });
    return res.status(outcome.record.statusCode).json(outcome.record.body);
  }

  if (outcome.type === 'conflict') {
    audit.log({
      actor: userId,
      action: 'idempotency.conflict',
      target: redisKey,
      payload: { idempotencyKey: key, fingerprint },
      outcome: 'failure',
      metadata: duplicateMetadata(req, key, fingerprint, { replayed: false }),
    });
    return res.status(409).json({
      error: 'Idempotency Conflict',
      message: 'The provided Idempotency-Key was already used with a different request payload.',
    });
  }

  if (outcome.type === 'in-progress') {
    audit.log({
      actor: userId,
      action: 'idempotency.in_progress',
      target: redisKey,
      payload: { idempotencyKey: key, fingerprint },
      outcome: 'failure',
      metadata: duplicateMetadata(req, key, fingerprint, { replayed: false }),
    });
    res.set('Retry-After', '1');
    return res.status(409).json({
      error: 'Idempotency In Progress',
      message:
        'A request with this Idempotency-Key is still in progress. Retry once it completes.',
    });
  }

  /**
   * This request owns the reservation. Intercept res.json to finalize it.
   *
   * Successful (2xx) responses replace the reservation with the cached
   * response. Non-2xx responses release it so the client can retry. Both are
   * compare-and-set on the owner token, so an expired owner cannot clobber a
   * newer reservation.
   */
  const reservation = outcome.value;
  const originalJson = res.json;
  res.json = function (data) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const completed = completedValue(fingerprint, res.statusCode, data);
      casSet(redisKey, reservation, completed, COMPLETED_TTL_SECONDS).catch((err) => {
        logger.error('[Idempotency] Failed to store result in Redis:', err);
      });
    } else {
      casDelete(redisKey, reservation).catch((err) => {
        logger.error('[Idempotency] Failed to release reservation:', err);
      });
    }

    // Restore original res.json behavior
    return originalJson.call(this, data);
  };

  return next();
};

module.exports = idempotency;
