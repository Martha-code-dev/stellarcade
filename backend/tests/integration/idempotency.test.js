const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

// In-memory Redis double. `set` with NX and `eval` run check-then-write with no
// await in between, so each command is atomic under Node's single thread. This
// is what lets the concurrency tests exercise the real middleware.
jest.mock('../../src/config/redis', () => {
  const store = new Map();
  const now = () => Date.now();
  const read = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
      store.delete(key);
      return null;
    }
    return entry.value;
  };
  const write = (key, value, ttlSeconds) => {
    store.set(key, {
      value,
      expiresAt: ttlSeconds ? now() + ttlSeconds * 1000 : undefined,
    });
  };

  const mockClient = {
    get: jest.fn(async (key) => read(key)),
    set: jest.fn(async (key, value, options = {}) => {
      if (options.NX && read(key) !== null) return null;
      write(key, value, options.EX);
      return 'OK';
    }),
    setEx: jest.fn(async (key, ttl, value) => {
      write(key, value, ttl);
      return 'OK';
    }),
    del: jest.fn(async (key) => {
      const existed = read(key) !== null;
      store.delete(key);
      return existed ? 1 : 0;
    }),
    // Emulates the middleware's compare-and-set/delete Lua script.
    eval: jest.fn(async (_script, { keys, arguments: args }) => {
      const [key] = keys;
      const [expected, next, ttl, mode] = args;
      if (read(key) !== expected) return 0;
      if (mode === 'delete') {
        store.delete(key);
        return 1;
      }
      write(key, next, Number(ttl));
      return 1;
    }),
    connect: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    isOpen: true,
    __store: store,
  };

  return { client: mockClient, connectPromise: Promise.resolve() };
});

jest.mock('../../src/services/audit.service', () => {
  const normalizeValue = (value) => {
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
          acc[key] = normalizeValue(value[key]);
          return acc;
        }, {});
    }
    return value;
  };

  return {
    log: jest.fn().mockResolvedValue(undefined),
    normalizeValue,
    redactSensitive: (value) => value,
  };
});

// Auth stub: user id comes from x-test-user so isolation can be exercised.
jest.mock('../../src/middleware/auth.middleware', () => (req, res, next) => {
  req.user = { id: Number(req.header('x-test-user')) || 1 };
  next();
});

const { client } = require('../../src/config/redis');
const audit = require('../../src/services/audit.service');
const walletRouter = require('../../src/routes/wallet.routes');

// Mock wallet controller to isolate middleware testing
jest.mock('../../src/controllers/wallet.controller', () => ({
  getBalance: jest.fn((req, res) =>
    res.status(200).json({ address: req.params.address, balances: {} })
  ),
  deposit: jest.fn((req, res) => res.status(200).json({ success: true, balance: 100 })),
  withdraw: jest.fn((req, res) => res.status(200).json({ success: true, balance: 50 })),
}));

const walletController = require('../../src/controllers/wallet.controller');

const app = express();
app.use(express.json());

// In our test environment, we mount the wallet router
// The mocked auth middleware will run as part of the router's middleware stack
app.use('/api/wallet', walletRouter);

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fingerprintOf = (body, method = 'POST', path = '/api/wallet/deposit') =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(audit.normalizeValue({ method, path, body })))
    .digest('hex');

const readRecord = (userId, key) => {
  const entry = client.__store.get(`idempotency:${userId}:${key}`);
  return entry ? JSON.parse(entry.value) : null;
};

beforeEach(() => {
  jest.clearAllMocks();
  client.__store.clear();
  walletController.deposit.mockImplementation((req, res) =>
    res.status(200).json({ success: true, balance: 100 })
  );
  walletController.withdraw.mockImplementation((req, res) =>
    res.status(200).json({ success: true, balance: 50 })
  );
  delete process.env.IDEMPOTENCY_PENDING_TTL_SECONDS;
});

describe('Idempotency Middleware Integration Tests', () => {
  test('reserves then caches a first-time request', async () => {
    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'unique-key-1')
      .send({ amount: 100 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(walletController.deposit).toHaveBeenCalledTimes(1);

    const record = readRecord(1, 'unique-key-1');
    expect(record).toMatchObject({
      state: 'completed',
      statusCode: 200,
      requestFingerprint: fingerprintOf({ amount: 100 }),
    });
    expect(record.body).toEqual({ success: true, balance: 100 });
  });

  test('replays the cached status and body for a completed request', async () => {
    walletController.deposit.mockImplementationOnce((req, res) =>
      res.status(201).json({ success: true, id: 'abc' })
    );

    const first = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'replay-key')
      .send({ amount: 100 });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'replay-key')
      .send({ amount: 100 });

    expect(second.status).toBe(201);
    expect(second.body).toEqual({ success: true, id: 'abc' });
    expect(walletController.deposit).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'idempotency.replay', outcome: 'success' })
    );
  });

  test('returns 409 Conflict for a completed key reused with a different body', async () => {
    await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'same-key')
      .send({ amount: 100 });

    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'same-key')
      .send({ amount: 999 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Idempotency Conflict');
    expect(walletController.deposit).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'idempotency.conflict', outcome: 'failure' })
    );
  });

  test('holds the first handler open and executes it once for concurrent duplicates', async () => {
    const entered = deferred();
    const release = deferred();
    walletController.deposit.mockImplementation(async (req, res) => {
      entered.resolve();
      await release.promise;
      res.status(200).json({ success: true });
    });

    // Start the first request without awaiting it so it stays in flight.
    const firstDone = request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'race-key')
      .send({ amount: 100 })
      .then((r) => r);
    await entered.promise;

    const second = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'race-key')
      .send({ amount: 100 });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('Idempotency In Progress');
    expect(second.headers['retry-after']).toBe('1');
    expect(walletController.deposit).toHaveBeenCalledTimes(1);

    release.resolve();
    const first = await firstDone;
    expect(first.status).toBe(200);
    expect(walletController.deposit).toHaveBeenCalledTimes(1);
  });

  test('conflicts when a different body arrives while the same key is pending', async () => {
    const entered = deferred();
    const release = deferred();
    walletController.deposit.mockImplementation(async (req, res) => {
      entered.resolve();
      await release.promise;
      res.status(200).json({ success: true });
    });

    const firstDone = request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'pending-mismatch')
      .send({ amount: 100 })
      .then((r) => r);
    await entered.promise;

    const second = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'pending-mismatch')
      .send({ amount: 999 });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('Idempotency Conflict');
    expect(walletController.deposit).toHaveBeenCalledTimes(1);

    release.resolve();
    await firstDone;
  });

  test('releases the reservation on a non-2xx response so the client can retry', async () => {
    walletController.deposit.mockImplementationOnce((req, res) =>
      res.status(400).json({ success: false, error: 'Bad Request' })
    );

    const first = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'retry-key')
      .send({ amount: 100 });
    expect(first.status).toBe(400);
    expect(readRecord(1, 'retry-key')).toBeNull();

    const second = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'retry-key')
      .send({ amount: 100 });
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(walletController.deposit).toHaveBeenCalledTimes(2);
  });

  test('an expired reservation does not block a new request', async () => {
    client.__store.set('idempotency:1:expired-key', {
      value: JSON.stringify({
        state: 'pending',
        requestFingerprint: 'stale',
        token: 'dead',
        startedAt: Date.now() - 60000,
      }),
      expiresAt: Date.now() - 1000,
    });

    const res = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'expired-key')
      .send({ amount: 100 });

    expect(res.status).toBe(200);
    expect(walletController.deposit).toHaveBeenCalledTimes(1);
  });

  test('a stale owner cannot overwrite the reservation that replaced it', async () => {
    process.env.IDEMPOTENCY_PENDING_TTL_SECONDS = '1';

    const entered = deferred();
    const release = deferred();
    walletController.deposit.mockImplementation(async (req, res) => {
      entered.resolve();
      await release.promise;
      res.status(200).json({ success: true, owner: 'A' });
    });

    const firstDone = request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'stale-key')
      .send({ amount: 100 })
      .then((r) => r);
    await entered.promise;

    // Wait past the logical lease; the key itself is still present (2x TTL).
    await sleep(1100);

    walletController.deposit.mockImplementation((req, res) =>
      res.status(200).json({ success: true, owner: 'B' })
    );
    const second = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'stale-key')
      .send({ amount: 100 });
    expect(second.status).toBe(200);
    expect(second.body.owner).toBe('B');

    // Owner A finally responds; its finalization must not clobber B's result.
    release.resolve();
    await firstDone;

    const third = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'stale-key')
      .send({ amount: 100 });
    expect(third.body.owner).toBe('B');
    expect(walletController.deposit).toHaveBeenCalledTimes(2);
  });

  test('the same key from two users is isolated', async () => {
    const first = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'shared-key')
      .set('x-test-user', '1')
      .send({ amount: 100 });
    const second = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'shared-key')
      .set('x-test-user', '2')
      .send({ amount: 100 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(walletController.deposit).toHaveBeenCalledTimes(2);
  });

  test('skips idempotency when the header is missing', async () => {
    const res = await request(app).post('/api/wallet/deposit').send({ amount: 100 });

    expect(res.status).toBe(200);
    expect(client.set).not.toHaveBeenCalled();
    expect(walletController.deposit).toHaveBeenCalledTimes(1);
  });

  test('treats reordered object keys as the same fingerprint', async () => {
    await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'normalized-hit')
      .send({ meta: { network: 'testnet', currency: 'XLM' }, amount: 100 });

    const second = await request(app)
      .post('/api/wallet/deposit')
      .set('Idempotency-Key', 'normalized-hit')
      .send({ amount: 100, meta: { currency: 'XLM', network: 'testnet' } });

    expect(second.status).toBe(200);
    expect(walletController.deposit).toHaveBeenCalledTimes(1);
  });
});
