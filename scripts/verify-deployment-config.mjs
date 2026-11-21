#!/usr/bin/env node
/**
 * Read-only verification for the testnet deployment manifest (issue #1586).
 *
 * Confirms that the manifest, README, and environment examples agree, and that
 * every configured on-chain address has a readable contract spec. No
 * transaction is submitted and no secret is read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const STALE_IDS = new Set([
  'CD2JPFUCKNDMA3OVYVQOAELTMR5VQPMAA6J6GJYQE2SQFNGKCBSSOKG5',
  'CD3VAX3DZEGWEMMPK35MYPS43HMFTNHZK5SY22JLEHHENXJATWP4HJY5',
]);

const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`PASS ${message}`);
  } else {
    failures.push(message);
    console.log(`FAIL ${message}`);
  }
}

function envValue(relativePath, key) {
  const source = read(relativePath);
  const match = source.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

function contractReadable(id, label) {
  const result = spawnSync(
    'stellar',
    ['contract', 'info', 'interface', '--id', id, '--network', 'testnet'],
    { encoding: 'utf8' },
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const ok = result.status === 0 && output.includes('pub trait Contract');
  check(ok, `${label} ${id}: contract found on testnet`);
  if (!ok) {
    const detail = output.trim().split('\n').slice(-1)[0] || 'no output from stellar CLI';
    console.log(`     ${detail}`);
  }
}

const manifest = JSON.parse(read('deployments/testnet.json'));
const readme = read('README.md');
const backendEnv = 'backend/.env.example';
const webEnv = 'apps/web/.env.example';

const configured = {
  coinFlip: manifest.contracts.coinFlip,
  randomGenerator: manifest.contracts.randomGenerator,
  diceRoll: manifest.contracts.diceRoll,
};

check(configured.diceRoll === '', 'diceRoll: not configured');
check(
  configured.coinFlip === envValue(backendEnv, 'COIN_FLIP_CONTRACT_ID') &&
    configured.coinFlip === envValue(webEnv, 'NEXT_PUBLIC_COIN_FLIP_CONTRACT_ID'),
  'manifest and env examples agree on coinFlip',
);
check(
  configured.randomGenerator === envValue(backendEnv, 'RANDOM_GENERATOR_CONTRACT_ID') &&
    configured.randomGenerator === envValue(webEnv, 'NEXT_PUBLIC_RANDOM_GENERATOR_CONTRACT_ID'),
  'manifest and env examples agree on randomGenerator',
);
check(
  !envValue(backendEnv, 'DICE_ROLL_CONTRACT_ID') &&
    !envValue(webEnv, 'NEXT_PUBLIC_DICE_ROLL_CONTRACT_ID'),
  'diceRoll is unset in env examples',
);
check(readme.includes(configured.coinFlip), 'README includes the canonical coinFlip ID');
check(readme.includes(configured.randomGenerator), 'README includes the canonical randomGenerator ID');
check(
  readme.includes('Not configured') && !readme.includes('`undefined`'),
  'README does not advertise a diceRoll ID',
);
check(
  ![...STALE_IDS].some((id) => readme.includes(id) || read(backendEnv).includes(id) || read(webEnv).includes(id)),
  'stale coinFlip and randomGenerator IDs are absent',
);

const stellarCheck = spawnSync('stellar', ['--version'], { encoding: 'utf8' });
if (stellarCheck.status !== 0) {
  failures.push('stellar CLI is required for on-chain verification');
  console.log('FAIL stellar CLI is required for on-chain verification');
} else {
  for (const [label, id] of [
    ['coinFlip', configured.coinFlip],
    ['randomGenerator', configured.randomGenerator],
    ['nativeToken', manifest.nativeToken],
  ]) {
    if (id) contractReadable(id, label);
  }
}

if (failures.length > 0) {
  console.log('\nRecovery:');
  console.log('  1. Confirm the address with: stellar contract info interface --id <ADDRESS> --network testnet');
  console.log('  2. Restore or extend an expired instance with stellar contract restore or stellar contract extend.');
  console.log('  3. Redeploy with scripts/deploy-contracts.sh --fresh --build if the contract is gone.');
  console.log('  4. Update deployments/testnet.json, README.md, and both env examples together.');
  process.exitCode = 1;
}
