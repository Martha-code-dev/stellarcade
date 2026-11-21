const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../../src/config/database', () => {
  const mock = jest.fn();
  mock.raw = jest.fn().mockResolvedValue({});
  return mock;
});

jest.mock('../../src/config/redis', () => ({
  client: {
    get: jest.fn().mockResolvedValue(null),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue('OK'),
    ttl: jest.fn().mockResolvedValue(60),
    setEx: jest.fn().mockResolvedValue('OK'),
    getDel: jest.fn().mockResolvedValue(null),
    connect: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    isOpen: true,
  },
  connectPromise: Promise.resolve(),
}));

jest.mock('../../src/services/audit.service', () => ({
  list: jest.fn().mockResolvedValue([]),
}));

const router = require('../../src/routes/users.routes');
const User = require('../../src/models/User.model');
const audit = require('../../src/services/audit.service');

jest.mock('../../src/models/User.model');

const app = express();
app.use(express.json());
app.use('/users', router);
app.use((err, req, res, _next) => {
  res.status(err.statusCode || 500).json({ error: { message: err.message, code: err.code } });
});

const OWNER = {
  id: 7,
  wallet_address: 'GALICE',
  username: 'alice',
  telegram_user_id: '944872850',
  telegram_handle: '@alice_tg',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

function tokenFor(payload) {
  return jwt.sign(payload, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
}

describe('public profile allowlist', () => {
  const OLD_ENV = process.env.JWT_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    User.findByWallet.mockResolvedValue(OWNER);
  });

  afterAll(() => {
    process.env.JWT_SECRET = OLD_ENV;
  });

  test('anonymous lookup excludes Telegram identifiers', async () => {
    const res = await request(app).get('/users/profile').query({ address: 'GALICE' });

    expect(res.status).toBe(200);
    expect(res.body.address).toBe('GALICE');
    expect(res.body.telegramUserId).toBeUndefined();
    expect(res.body.telegramHandle).toBeUndefined();
    expect(res.body.telegramLinked).toBeUndefined();
  });

  test('owner lookup includes permitted linked-account detail', async () => {
    const res = await request(app)
      .get('/users/profile')
      .query({ address: 'GALICE' })
      .set('Authorization', `Bearer ${tokenFor({ id: 7, walletAddress: 'GALICE' })}`);

    expect(res.status).toBe(200);
    expect(res.body.telegramLinked).toBe(true);
    expect(res.body.telegramUserId).toBe('944872850');
    expect(res.body.telegramHandle).toBe('@alice_tg');
  });

  test('another wallet does not receive owner-only detail', async () => {
    const res = await request(app)
      .get('/users/profile')
      .query({ address: 'GALICE' })
      .set('Authorization', `Bearer ${tokenFor({ id: 8, walletAddress: 'GBOB' })}`);

    expect(res.status).toBe(200);
    expect(res.body.telegramUserId).toBeUndefined();
    expect(res.body.telegramHandle).toBeUndefined();
  });

  test('missing profile keeps its documented 404 response', async () => {
    User.findByWallet.mockResolvedValue(null);

    const res = await request(app).get('/users/profile').query({ address: 'GMISSING' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
  });
});

describe('audit log scoping', () => {
  const OLD_ENV = { jwt: process.env.JWT_SECRET, roles: process.env.AUDIT_ADMIN_ROLES };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.AUDIT_ADMIN_ROLES;
  });

  afterAll(() => {
    process.env.JWT_SECRET = OLD_ENV.jwt;
    if (OLD_ENV.roles === undefined) delete process.env.AUDIT_ADMIN_ROLES;
    else process.env.AUDIT_ADMIN_ROLES = OLD_ENV.roles;
  });

  test('scopes an omitted actor query to the authenticated actor', async () => {
    const res = await request(app)
      .get('/users/audit-logs')
      .set('Authorization', `Bearer ${tokenFor({ id: 7, walletAddress: 'GALICE' })}`);

    expect(res.status).toBe(200);
    expect(audit.list).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'GALICE', allowGlobal: false })
    );
  });

  test('allows an owner to query their own actor explicitly', async () => {
    const res = await request(app)
      .get('/users/audit-logs')
      .query({ actor: 'GALICE' })
      .set('Authorization', `Bearer ${tokenFor({ id: 7, walletAddress: 'GALICE' })}`);

    expect(res.status).toBe(200);
    expect(audit.list).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'GALICE', allowGlobal: false })
    );
  });

  test('denies a forged actor query', async () => {
    const res = await request(app)
      .get('/users/audit-logs')
      .query({ actor: 'GBOB' })
      .set('Authorization', `Bearer ${tokenFor({ id: 7, walletAddress: 'GALICE' })}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUDIT_ACTOR_FORBIDDEN');
    expect(audit.list).not.toHaveBeenCalled();
  });

  test('denies an unauthorized global query', async () => {
    const res = await request(app)
      .get('/users/audit-logs')
      .query({ actor: '*' })
      .set('Authorization', `Bearer ${tokenFor({ id: 7, walletAddress: 'GALICE' })}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUDIT_GLOBAL_FORBIDDEN');
    expect(audit.list).not.toHaveBeenCalled();
  });

  test('allows a global query under an explicit admin policy', async () => {
    process.env.AUDIT_ADMIN_ROLES = 'admin,operator';

    const res = await request(app)
      .get('/users/audit-logs')
      .query({ actor: '*' })
      .set(
        'Authorization',
        `Bearer ${tokenFor({ id: 1, walletAddress: 'GADMIN', roles: ['admin'] })}`
      );

    expect(res.status).toBe(200);
    expect(audit.list).toHaveBeenCalledWith(
      expect.objectContaining({ actor: undefined, allowGlobal: true })
    );
  });
});
