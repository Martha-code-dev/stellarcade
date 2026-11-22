const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const SECRET = 'test-webhook-secret';
const TOLERANCE_MS = 300 * 1000;

// A small in-memory stand-in for Redis. It implements the subset the replay
// guard uses and keeps its data outside the middleware module, so two Express
// apps share the same store exactly like two backend instances share Redis.
const redisStore = new Map();

const mockRedisClient = {
  isReady: true,
  isOpen: true,
  set: jest.fn(async (key, value, options = {}) => {
    const now = Date.now();
    const existing = redisStore.get(key);
    if (existing && existing.expiresAt > now) {
      if (options.NX) {
        return null;
      }
    }

    const ttlMs = Number(options.PX) || 0;
    redisStore.set(key, { value, expiresAt: now + ttlMs });
    return 'OK';
  }),
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue('OK'),
};

jest.mock('../../src/config/redis', () => ({
  client: mockRedisClient,
  connectPromise: Promise.resolve(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const webhookSignature = require('../../src/middleware/webhook-signature.middleware');
const { clearMemoryReplayCache } = require('../../src/services/webhook-replay');

const buildApp = () => {
  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.post('/webhook', webhookSignature, (req, res) => {
    res.status(200).json({ received: true });
  });
  return app;
};

const sign = (timestamp, body) => {
  const payload = Buffer.concat([
    Buffer.from(`${timestamp}.`),
    Buffer.from(JSON.stringify(body)),
  ]);
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
};

const post = (app, { timestamp, signature, body = { event: 'deposit' } }) =>
  request(app)
    .post('/webhook')
    .set('x-webhook-signature', `t=${timestamp},v1=${signature}`)
    .send(body);

describe('Webhook replay protection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisStore.clear();
    clearMemoryReplayCache();
    mockRedisClient.isReady = true;
    process.env.WEBHOOK_SIGNING_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SIGNING_SECRET;
  });

  test('accepts the first valid delivery and rejects an identical replay', async () => {
    const app = buildApp();
    const timestamp = Math.floor(Date.now() / 1000);
    const body = { event: 'deposit', amount: 10 };
    const signature = sign(timestamp, body);

    const first = await post(app, { timestamp, signature, body });
    const replay = await post(app, { timestamp, signature, body });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(replay.body.error).toBe('Webhook Replay Detected');
    expect(redisStore.size).toBe(1);
    expect(mockRedisClient.set).toHaveBeenCalledWith(
      expect.stringMatching(/^webhook:replay:/),
      '1',
      { NX: true, PX: TOLERANCE_MS }
    );
  });

  test('rejects the same signature on another instance after a process restart', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = { event: 'deposit', amount: 10 };
    const signature = sign(timestamp, body);

    const firstInstance = await post(buildApp(), { timestamp, signature, body });

    // A restart clears process-local state. The reservation must survive in
    // Redis so another instance still rejects the replay.
    clearMemoryReplayCache();
    const secondInstance = await post(buildApp(), { timestamp, signature, body });

    expect(firstInstance.status).toBe(200);
    expect(secondInstance.status).toBe(403);
    expect(secondInstance.body.error).toBe('Webhook Replay Detected');
  });

  test('rejects an expired timestamp without reserving a replay key', async () => {
    const app = buildApp();
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const body = { event: 'deposit' };
    const signature = sign(timestamp, body);

    const res = await post(app, { timestamp, signature, body });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Webhook Signature Expired');
    expect(redisStore.size).toBe(0);
    expect(mockRedisClient.set).not.toHaveBeenCalled();
  });

  test('rejects an invalid signature without reserving a replay key', async () => {
    const app = buildApp();
    const timestamp = Math.floor(Date.now() / 1000);
    const body = { event: 'deposit' };
    const invalidSignature = 'a'.repeat(64);

    const invalid = await post(app, { timestamp, signature: invalidSignature, body });

    expect(invalid.status).toBe(401);
    expect(invalid.body.error).toBe('Invalid Webhook Signature');
    expect(redisStore.size).toBe(0);

    const valid = await post(app, { timestamp, signature: sign(timestamp, body), body });

    expect(valid.status).toBe(200);
    expect(redisStore.size).toBe(1);
  });

  test('falls back to a process-local guard when Redis is not ready', async () => {
    mockRedisClient.isReady = false;
    const app = buildApp();
    const timestamp = Math.floor(Date.now() / 1000);
    const body = { event: 'deposit' };
    const signature = sign(timestamp, body);

    const first = await post(app, { timestamp, signature, body });
    const replay = await post(app, { timestamp, signature, body });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(mockRedisClient.set).not.toHaveBeenCalled();
  });
});
