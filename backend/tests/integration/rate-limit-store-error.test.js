const express = require('express');
const request = require('supertest');

const mockRedisClient = {
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
  get: jest.fn(),
  setEx: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
  isOpen: true,
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

jest.mock('../../src/controllers/auth.controller', () => ({
  postChallenge: jest.fn((_req, res) => res.status(200).json({ ok: 'challenge' })),
  postLogin: jest.fn((_req, res) => res.status(200).json({ ok: 'login' })),
}));

jest.mock('../../src/controllers/games.controller', () => ({
  getGames: jest.fn((_req, res) => res.status(200).json({ ok: 'games' })),
  getRecentGames: jest.fn((_req, res) => res.status(200).json({ ok: 'recent' })),
  getIndexedGame: jest.fn((_req, res) => res.status(200).json({ ok: 'indexed' })),
  getLeaderboard: jest.fn((_req, res) => res.status(200).json({ ok: 'leaderboard' })),
}));

const authRouter = require('../../src/routes/auth.routes');
const gamesRouter = require('../../src/routes/games.routes');
const authController = require('../../src/controllers/auth.controller');
const gamesController = require('../../src/controllers/games.controller');
const logger = require('../../src/utils/logger');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api/games', gamesRouter);

describe('rate-limit store failure policy (#1529)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient.incr.mockRejectedValue(new Error('Redis connection lost'));
  });

  test('POST /api/auth/login fails closed with 503 and never reaches the controller', async () => {
    const res = await request(app).post('/api/auth/login').send({ address: 'GALICE' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
    expect(authController.postLogin).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('policy auth'),
      expect.any(Error)
    );
  });

  test('POST /api/auth/challenge fails closed too', async () => {
    const res = await request(app).post('/api/auth/challenge').send({ address: 'GALICE' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
    expect(authController.postChallenge).not.toHaveBeenCalled();
  });

  test('GET /api/games still succeeds when the store errors', async () => {
    const res = await request(app).get('/api/games');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe('games');
    expect(gamesController.getGames).toHaveBeenCalled();
  });
});
