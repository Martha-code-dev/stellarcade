/**
 * Quest progress is written by a single atomic upsert. These tests use the
 * in-memory SQLite driver already available to the backend test suite and a
 * barrier on `user_quests` queries so two resolutions really do overlap.
 */
let mockBarrier = null;

jest.mock('../../src/config/database', () => {
  const knex = require('knex')({
    client: 'sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
  });

  return new Proxy(knex, {
    apply(target, thisArg, args) {
      const builder = target(...args);
      if (!mockBarrier || args[0] !== 'user_quests') return builder;

      const originalThen = builder.then.bind(builder);
      builder.then = (...thenArgs) => mockBarrier.wait().then(() => originalThen(...thenArgs));
      return builder;
    },
  });
});

const db = require('../../src/config/database');
const QuestModel = require('../../src/models/Quest.model');

function createBarrier(count) {
  let waiting = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    wait() {
      waiting += 1;
      if (waiting === count) release();
      return gate;
    },
  };
}

const USER_ID = 1;

async function seedRow(patch = {}) {
  await db('user_quests').insert({
    user_id: USER_ID,
    quest_id: 1,
    progress: 0,
    claimed: false,
    streak: 0,
    updated_at: '2026-01-01 00:00:00',
    ...patch,
  });
}

beforeAll(async () => {
  await db.schema.createTable('quests', (table) => {
    table.increments('id').primary();
    table.string('quest_id', 50).unique().notNullable();
    table.string('title', 100).notNullable();
    table.integer('target').notNullable();
  });
  await db.schema.createTable('user_quests', (table) => {
    table.increments('id').primary();
    table.integer('user_id').unsigned().notNullable();
    table.integer('quest_id').unsigned().notNullable();
    table.integer('progress').notNullable().defaultTo(0);
    table.boolean('claimed').notNullable().defaultTo(false);
    table.integer('streak').notNullable().defaultTo(0);
    table.timestamp('updated_at');
    table.unique(['user_id', 'quest_id']);
  });
});

beforeEach(async () => {
  mockBarrier = null;
  await db('user_quests').delete();
  await db('quests').delete();
  await db('quests').insert([
    { id: 1, quest_id: 'play-5-games', title: 'Play 5 games', target: 5 },
    { id: 2, quest_id: 'daily-login', title: 'Log in today', target: 1 },
  ]);
});

afterAll(async () => {
  await db.destroy();
});

describe('QuestModel.recordProgress', () => {
  test('returns null when the quest slug does not exist', async () => {
    await expect(QuestModel.recordProgress(USER_ID, 'no-such-quest')).resolves.toBeNull();
    expect(await db('user_quests')).toHaveLength(0);
  });

  test('keeps every increment when two resolutions overlap', async () => {
    await seedRow();
    mockBarrier = createBarrier(2);

    await Promise.all([
      QuestModel.recordProgress(USER_ID, 'play-5-games', 1),
      QuestModel.recordProgress(USER_ID, 'play-5-games', 1),
    ]);

    const [row] = await db('user_quests').where({ user_id: USER_ID, quest_id: 1 });
    expect(row.progress).toBe(2);
    expect(row.claimed).toBe(0);
    expect(row.streak).toBe(0);
  });

  test('caps at the target and increments the streak exactly once', async () => {
    await seedRow({ progress: 4 });
    mockBarrier = createBarrier(2);

    await Promise.all([
      QuestModel.recordProgress(USER_ID, 'play-5-games', 2),
      QuestModel.recordProgress(USER_ID, 'play-5-games', 2),
    ]);

    const [row] = await db('user_quests').where({ user_id: USER_ID, quest_id: 1 });
    expect(row.progress).toBe(5);
    // Completion is not settlement: progress tracking must never set `claimed`
    // (#1588).
    expect(row.claimed).toBe(0);
    expect(row.streak).toBe(1);
  });

  test('never settles a reward: a pre-settled claimed flag survives a progress write', async () => {
    await seedRow({ progress: 3, claimed: true, streak: 1 });

    await QuestModel.recordProgress(USER_ID, 'play-5-games', 1);

    const [row] = await db('user_quests').where({ user_id: USER_ID, quest_id: 1 });
    expect(row.progress).toBe(4);
    expect(row.claimed).toBe(1);
    expect(row.streak).toBe(1);
  });

  test('two first-time inserts converge on one row instead of racing', async () => {
    mockBarrier = createBarrier(2);

    const results = await Promise.all([
      QuestModel.recordProgress(USER_ID, 'play-5-games', 1),
      QuestModel.recordProgress(USER_ID, 'play-5-games', 1),
    ]);

    const rows = await db('user_quests').where({ user_id: USER_ID, quest_id: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].progress).toBe(2);
    expect(results).toHaveLength(2);
  });
});

describe('QuestModel.recordDailyLogin', () => {
  const startOfUtcDay = (offsetDays = 0) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return `${date.toISOString().slice(0, 10)} 00:00:00`;
  };

  test('records the first login of the day without settling the reward', async () => {
    const row = await QuestModel.recordDailyLogin(USER_ID);
    // Daily completion is not settlement; `claimed` is reserved for payout
    // (#1588).
    expect(row).toMatchObject({ progress: 1, claimed: 0, streak: 1 });
  });

  test('never settles a reward: a pre-settled claimed flag survives a check-in', async () => {
    await seedRow({
      quest_id: 2,
      progress: 1,
      claimed: true,
      streak: 3,
      updated_at: startOfUtcDay(-1),
    });

    const row = await QuestModel.recordDailyLogin(USER_ID);
    expect(row.streak).toBe(4);
    expect(row.claimed).toBe(1);
  });

  test('a second call the same day is a no-op', async () => {
    await QuestModel.recordDailyLogin(USER_ID);
    await db('user_quests')
      .where({ user_id: USER_ID, quest_id: 2 })
      .update({ streak: 7, updated_at: startOfUtcDay() });

    const row = await QuestModel.recordDailyLogin(USER_ID);
    expect(row.streak).toBe(7);
  });

  test('a next-day login extends the streak', async () => {
    await seedRow({
      quest_id: 2,
      progress: 1,
      claimed: true,
      streak: 3,
      updated_at: startOfUtcDay(-1),
    });

    const row = await QuestModel.recordDailyLogin(USER_ID);
    expect(row.streak).toBe(4);
  });

  test('a longer gap resets the streak to one', async () => {
    await seedRow({
      quest_id: 2,
      progress: 1,
      claimed: true,
      streak: 9,
      updated_at: startOfUtcDay(-3),
    });

    const row = await QuestModel.recordDailyLogin(USER_ID);
    expect(row.streak).toBe(1);
  });
});
