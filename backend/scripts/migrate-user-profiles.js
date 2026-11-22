/**
 * One-time migration from the web app's legacy `.data/user_profiles.json`
 * into the canonical PostgreSQL `users` table.
 *
 * Run offline from the backend directory:
 *   npm run migrate:profiles
 *
 * Collision policy (deterministic, so a rerun is a no-op):
 *   - A wallet already in the database keeps its stored username.
 *   - An age confirmation is unioned: if either side has one, the DB ends up
 *     with one. It is never cleared.
 *   - A file row for a missing wallet is inserted, unless another wallet
 *     already holds that username. Collisions are reported, never reassigned.
 *   - Invalid addresses/usernames and sentinel rows are skipped and reported.
 *   - A corrupt source file throws before any write happens.
 */
const fs = require('fs');
const path = require('path');

const { validateWalletAddress, validateUsernameValue } = require('../src/utils/profile-validation');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SOURCE = path.join(REPO_ROOT, 'apps', 'web', '.data', 'user_profiles.json');

class ProfileMigrationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProfileMigrationError';
    this.code = code;
  }
}

/** Reads and parses the source file. Parsing happens before any DB work. */
function readProfiles(sourceFile = DEFAULT_SOURCE) {
  if (!fs.existsSync(sourceFile)) {
    return {};
  }

  const content = fs.readFileSync(sourceFile, 'utf-8');
  if (!content.trim()) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ProfileMigrationError(
      `Profile file ${sourceFile} is not valid JSON: ${error.message}`,
      'CORRUPT_PROFILE_FILE'
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProfileMigrationError(
      `Profile file ${sourceFile} must contain an object keyed by wallet address.`,
      'CORRUPT_PROFILE_FILE'
    );
  }
  return parsed;
}

function parseConfirmation(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Applies `profiles` to `database`. Kept separate from file I/O so tests can
 * drive every collision class with in-memory fixtures.
 */
async function migrateProfiles(profiles, database, logger = console) {
  const db = database || require('../src/config/database');
  const report = {
    inserted: [],
    updated: [],
    skipped: [],
    collisions: [],
    total: Object.keys(profiles).length,
  };

  const rows = await db('users').select('id', 'wallet_address', 'username', 'age_confirmed_at');
  const byWallet = new Map(rows.map((row) => [row.wallet_address, row]));
  const byUsername = new Map();
  for (const row of rows) {
    const name = typeof row.username === 'string' ? row.username.trim().toLowerCase() : '';
    if (name && !byUsername.has(name)) byUsername.set(name, row.wallet_address);
  }

  // Stable order makes the report reproducible and collisions deterministic.
  const addresses = Object.keys(profiles).sort();
  for (const address of addresses) {
    const record = profiles[address];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      report.skipped.push({ address, reason: 'INVALID_RECORD' });
      continue;
    }

    const addressProblem = validateWalletAddress(record.address || address);
    if (addressProblem) {
      report.skipped.push({ address, reason: 'INVALID_ADDRESS' });
      continue;
    }

    const usernameProblem = validateUsernameValue(record.username, { required: true });
    if (usernameProblem) {
      report.skipped.push({ address, reason: 'INVALID_USERNAME' });
      continue;
    }

    const username = record.username.trim();
    const normalized = username.toLowerCase();
    const confirmation = parseConfirmation(record.ageConfirmedAt);
    const existing = byWallet.get(address);

    if (existing) {
      // The database wins on identity. Only a missing confirmation is filled.
      if (!existing.age_confirmed_at && confirmation) {
        await db('users')
          .where({ wallet_address: address })
          .update({ age_confirmed_at: confirmation.toISOString() });
        existing.age_confirmed_at = confirmation.toISOString();
        report.updated.push({ address, field: 'age_confirmed_at' });
      } else {
        report.skipped.push({ address, reason: 'ALREADY_PRESENT' });
      }
      continue;
    }

    const holder = byUsername.get(normalized);
    if (holder) {
      report.collisions.push({ address, username, heldBy: holder });
      continue;
    }

    await db('users').insert({
      wallet_address: address,
      username,
      age_confirmed_at: confirmation ? confirmation.toISOString() : null,
    });
    byWallet.set(address, {
      wallet_address: address,
      username,
      age_confirmed_at: confirmation ? confirmation.toISOString() : null,
    });
    byUsername.set(normalized, address);
    report.inserted.push({ address, username });
  }

  if (logger.info) {
    logger.info('Profile migration complete', {
      inserted: report.inserted.length,
      updated: report.updated.length,
      skipped: report.skipped.length,
      collisions: report.collisions.length,
      total: report.total,
    });
  }

  return report;
}

async function main() {
  const sourceFile = process.env.PROFILES_FILE || DEFAULT_SOURCE;
  const profiles = readProfiles(sourceFile);
  const report = await migrateProfiles(profiles);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SOURCE,
  ProfileMigrationError,
  migrateProfiles,
  readProfiles,
  main,
};
