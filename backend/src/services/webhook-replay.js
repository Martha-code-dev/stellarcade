const { client } = require('../config/redis');
const logger = require('../utils/logger');

const REPLAY_KEY_PREFIX = 'webhook:replay:';

// Process-local fallback. It only protects a single instance, so it is used
// when Redis is unavailable (local development, tests, or a Redis outage).
// Production deployments that run more than one backend need Redis for the
// guard to be shared.
const memoryReplays = new Map();

const redisKeyFor = (key) => `${REPLAY_KEY_PREFIX}${key}`;

const purgeExpiredMemoryKeys = (now) => {
  for (const [key, expiresAt] of memoryReplays.entries()) {
    if (expiresAt <= now) {
      memoryReplays.delete(key);
    }
  }
};

const reserveInMemory = (key, ttlMs) => {
  const now = Date.now();
  purgeExpiredMemoryKeys(now);

  if (memoryReplays.has(key)) {
    return false;
  }

  memoryReplays.set(key, now + ttlMs);
  return true;
};

/**
 * Atomically reserve a replay key for `ttlMs`.
 *
 * Redis uses `SET key value NX PX ttl`, which is atomic across instances. If
 * Redis is not ready, the process-local Map fallback is used. The fallback is
 * still atomic within a single Node process, but it cannot see requests that
 * were handled by another instance.
 *
 * @param {string} key - Stable replay identity (timestamp plus signature).
 * @param {number} ttlMs - How long the reservation must survive.
 * @returns {Promise<boolean>} true when the caller owns the reservation.
 */
const reserveReplayKey = async (key, ttlMs) => {
  const redisKey = redisKeyFor(key);

  if (client && client.isReady) {
    try {
      const result = await client.set(redisKey, '1', { NX: true, PX: ttlMs });
      return result === 'OK';
    } catch (error) {
      logger.error('[WebhookReplay] Redis reservation failed, using process-local fallback:', error);
    }
  }

  return reserveInMemory(redisKey, ttlMs);
};

/** Clear the process-local fallback. Redis entries keep their own TTL. */
const clearMemoryReplayCache = () => {
  memoryReplays.clear();
};

module.exports = {
  reserveReplayKey,
  clearMemoryReplayCache,
};
