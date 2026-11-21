const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../../src/config/database', () => {
  const mock = jest.fn();
  mock.raw = jest.fn().mockResolvedValue({});
  return mock;
});

jest.mock('../../src/config/redis', () => {
  const mockClient = {
    get: jest.fn(),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue('OK'),
    ttl: jest.fn().mockResolvedValue(60),
    setEx: jest.fn().mockResolvedValue('OK'),
    getDel: jest.fn().mockResolvedValue(null),
    connect: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    isOpen: true,
  };
  return { client: mockClient, connectPromise: Promise.resolve() };
});

const router = require('../../src/routes/quests.routes');
const User = require('../../src/models/User.model');
const QuestModel = require('../../src/models/Quest.model');

jest.mock('../../src/models/User.model');
jest.mock('../../src/models/Quest.model');

const app = express();
app.use(express.json());
app.use('/quests', router);
app.use((err, req, res, _next) => {
  res.status(err.statusCode || 500).json({ error: { message: err.message, code: err.code } });
});

function tokenFor(user) {
  return jwt.sign(user, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
}

describe('GET /quests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('400s when the player query parameter is missing', async () => {
    const res = await request(app).get('/quests');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QUERY_PARAM');
    expect(User.findByWallet).not.toHaveBeenCalled();
  });

  test('returns the quest catalog at zero progress for a player with no account yet', async () => {
    User.findByWallet.mockResolvedValue(null);
    QuestModel.listDefinitions.mockResolvedValue([
      { id: 1, questId: 'daily-login', title: 'Log in today', target: 1 },
      { id: 2, questId: 'play-5-games', title: 'Play 5 games', target: 5 },
    ]);

    const res = await request(app).get('/quests').query({ player: 'GUNKNOWN' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { questId: 'daily-login', progress: 0, target: 1, claimed: false, streak: 0 },
      { questId: 'play-5-games', progress: 0, target: 5, claimed: false, streak: 0 },
    ]);
    expect(QuestModel.getProgressForUser).not.toHaveBeenCalled();
    expect(QuestModel.recordDailyLogin).not.toHaveBeenCalled();
  });

  test('returns the player\'s real DB-backed progress without recording a check-in', async () => {
    User.findByWallet.mockResolvedValue({ id: 7, wallet_address: 'GALICE' });
    QuestModel.getProgressForUser.mockResolvedValue([
      { questId: 'daily-login', target: 1, progress: 1, claimed: true, streak: 4 },
      { questId: 'play-5-games', target: 5, progress: 2, claimed: false, streak: 0 },
    ]);

    const res = await request(app).get('/quests').query({ player: 'GALICE' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { questId: 'daily-login', progress: 1, target: 1, claimed: true, streak: 4 },
      { questId: 'play-5-games', progress: 2, target: 5, claimed: false, streak: 0 },
    ]);
    expect(QuestModel.getProgressForUser).toHaveBeenCalledWith(7);
    expect(QuestModel.recordDailyLogin).not.toHaveBeenCalled();
  });
});

describe('POST /quests/check-in', () => {
  const OLD_ENV = process.env.JWT_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(() => {
    process.env.JWT_SECRET = OLD_ENV;
  });

  test('401s without authentication', async () => {
    const res = await request(app).post('/quests/check-in').send({});

    expect(res.status).toBe(401);
    expect(QuestModel.recordDailyLogin).not.toHaveBeenCalled();
  });

  test('records exactly one check-in for the authenticated owner', async () => {
    User.findById.mockResolvedValue({ id: 7, wallet_address: 'GALICE' });
    QuestModel.recordDailyLogin.mockResolvedValue({ streak: 5 });

    const res = await request(app)
      .post('/quests/check-in')
      .set('Authorization', `Bearer ${tokenFor({ id: 7, walletAddress: 'GALICE' })}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.quest.streak).toBe(5);
    expect(QuestModel.recordDailyLogin).toHaveBeenCalledTimes(1);
    expect(QuestModel.recordDailyLogin).toHaveBeenCalledWith(7);
  });

  test('ignores caller-supplied user identity so another player cannot extend it', async () => {
    User.findById.mockResolvedValue({ id: 8, wallet_address: 'GBOB' });
    QuestModel.recordDailyLogin.mockResolvedValue({ streak: 1 });

    const res = await request(app)
      .post('/quests/check-in')
      .set('Authorization', `Bearer ${tokenFor({ id: 8, walletAddress: 'GBOB' })}`)
      .send({ userId: 7, walletAddress: 'GALICE', address: 'GALICE' });

    expect(res.status).toBe(200);
    expect(QuestModel.recordDailyLogin).toHaveBeenCalledTimes(1);
    expect(QuestModel.recordDailyLogin).toHaveBeenCalledWith(8);
  });

  test('404s when the authenticated user no longer exists', async () => {
    User.findById.mockResolvedValue(null);

    const res = await request(app)
      .post('/quests/check-in')
      .set('Authorization', `Bearer ${tokenFor({ id: 404, walletAddress: 'GONE' })}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
    expect(QuestModel.recordDailyLogin).not.toHaveBeenCalled();
  });

  test('a completed quest without settlement evidence is not reported as claimed', async () => {
    User.findByWallet.mockResolvedValue({ id: 7, wallet_address: 'GALICE' });
    QuestModel.getProgressForUser.mockResolvedValue([
      // progress reached target (completed) but no payout (claimed false)
      { questId: 'play-5-games', target: 5, progress: 5, claimed: false, streak: 1 },
    ]);

    const res = await request(app).get('/quests').query({ player: 'GALICE' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { questId: 'play-5-games', progress: 5, target: 5, claimed: false, streak: 1 },
    ]);
    // Completion is visible through progress, but the XP/payout flag the UI
    // consumes stays false until a real settlement (#1588).
    expect(res.body[0].progress).toBeGreaterThanOrEqual(res.body[0].target);
    expect(res.body[0].claimed).toBe(false);
  });
});
