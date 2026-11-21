const fs = require('fs');
const os = require('os');
const path = require('path');
const knex = require('knex');

const {
  ProfileMigrationError,
  migrateProfiles,
  readProfiles,
} = require('../../scripts/migrate-user-profiles');

const WALLET_A = 'GAEP3MEIODZFPOYG3H644CBXWFSPGCQC7DM74GSJIH6SH7RJZTAE3XYE';
const WALLET_B = 'GB6DPI6X5XQQWFOFTI4MEUMEENQ3BKABMEURF6Q6HHGE2WMJDSUX3O2Z';
const WALLET_C = 'GAG2RBIWVIWBZAL6LOBLIL5WXO3OPWMD7I2SAJTCOEWE3VPGIEXUZWN7';
const AGE = '2026-01-01T00:00:00.000Z';

let db;

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: ':memory:', useNullAsDefault: true });
  await db.schema.createTable('users', (table) => {
    table.increments('id').primary();
    table.string('wallet_address', 56).unique().notNullable();
    table.string('username', 50).nullable();
    table.timestamp('age_confirmed_at').nullable();
  });
});

afterEach(async () => {
  await db.destroy();
});

describe('migrateProfiles', () => {
  test('inserts a file record for a wallet missing from the database', async () => {
    const report = await migrateProfiles(
      { [WALLET_A]: { address: WALLET_A, username: 'nova_runner', ageConfirmedAt: AGE } },
      db
    );

    expect(report.inserted).toEqual([{ address: WALLET_A, username: 'nova_runner' }]);
    const [row] = await db('users').where({ wallet_address: WALLET_A });
    expect(row.username).toBe('nova_runner');
    expect(new Date(row.age_confirmed_at).toISOString()).toBe(AGE);
  });

  test('the database wins on username but a missing age confirmation is unioned', async () => {
    await db('users').insert({
      wallet_address: WALLET_A,
      username: 'db_name',
      age_confirmed_at: null,
    });

    const report = await migrateProfiles(
      { [WALLET_A]: { address: WALLET_A, username: 'file_name', ageConfirmedAt: AGE } },
      db
    );

    const [row] = await db('users').where({ wallet_address: WALLET_A });
    expect(row.username).toBe('db_name');
    expect(new Date(row.age_confirmed_at).toISOString()).toBe(AGE);
    expect(report.updated).toEqual([{ address: WALLET_A, field: 'age_confirmed_at' }]);
    expect(report.collisions).toHaveLength(0);
  });

  test('a username held by another wallet is reported, never reassigned', async () => {
    await db('users').insert({ wallet_address: WALLET_B, username: 'taken_name' });

    const report = await migrateProfiles(
      { [WALLET_A]: { address: WALLET_A, username: 'TAKEN_NAME', ageConfirmedAt: AGE } },
      db
    );

    expect(report.collisions).toEqual([
      { address: WALLET_A, username: 'TAKEN_NAME', heldBy: WALLET_B },
    ]);
    expect(await db('users').where({ wallet_address: WALLET_A })).toHaveLength(0);
  });

  test('invalid addresses, usernames and sentinel rows are skipped', async () => {
    const report = await migrateProfiles(
      {
        G_GUEST_PLAYER: { address: 'G_GUEST_PLAYER', username: 'ghost' },
        [WALLET_A]: { address: WALLET_A, username: 'ab' },
        [WALLET_B]: { address: WALLET_B, username: 'bad@name' },
        [WALLET_C]: { address: WALLET_C, username: 'valid_name' },
      },
      db
    );

    expect(report.skipped.map((entry) => entry.reason)).toEqual([
      'INVALID_USERNAME',
      'INVALID_USERNAME',
      'INVALID_ADDRESS',
    ]);
    expect(report.inserted).toEqual([{ address: WALLET_C, username: 'valid_name' }]);
  });

  test('a second run is a no-op', async () => {
    const profiles = {
      [WALLET_A]: { address: WALLET_A, username: 'nova_runner', ageConfirmedAt: AGE },
    };
    const first = await migrateProfiles(profiles, db);
    const second = await migrateProfiles(profiles, db);

    expect(first.inserted).toHaveLength(1);
    expect(second.inserted).toHaveLength(0);
    expect(second.updated).toHaveLength(0);
    expect(second.skipped).toEqual([{ address: WALLET_A, reason: 'ALREADY_PRESENT' }]);
    expect(await db('users')).toHaveLength(1);
  });
});

describe('readProfiles', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcade-migration-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns an empty object when the file does not exist', () => {
    expect(readProfiles(path.join(dir, 'missing.json'))).toEqual({});
  });

  test('throws a typed error and never yields data when the JSON is corrupt', () => {
    const file = path.join(dir, 'user_profiles.json');
    fs.writeFileSync(file, '{ this is not json', 'utf-8');

    expect(() => readProfiles(file)).toThrow(ProfileMigrationError);
    try {
      readProfiles(file);
    } catch (error) {
      expect(error.code).toBe('CORRUPT_PROFILE_FILE');
    }
  });

  test('rejects JSON that is not keyed by wallet address', () => {
    const file = path.join(dir, 'user_profiles.json');
    fs.writeFileSync(file, '[]', 'utf-8');

    expect(() => readProfiles(file)).toThrow(ProfileMigrationError);
  });
});
