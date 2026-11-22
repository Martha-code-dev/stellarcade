/**
 * Unit tests for worker shutdown draining (#1577).
 *
 * The server closes the database and RPC connections on SIGTERM/SIGINT. A
 * worker cycle that is mid-write must finish first, otherwise the last event
 * can be half-applied. These tests drive the real polling loops in
 * startIndexerWorker / startOracleWorker and assert that stop() waits for the
 * in-flight cycle, bounded by a deadline.
 */
const StellarSdk = require('@stellar/stellar-sdk');

const mockLogger = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock('../../src/utils/logger', () => mockLogger);

const db = require('../../src/config/database');
const { startIndexerWorker } = require('../../src/services/indexer.worker');
const { startOracleWorker } = require('../../src/services/oracle.worker');

const ORACLE = StellarSdk.Keypair.random();
const RNG_ID = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 1));
const COIN_FLIP_ID = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 2));

/** A promise plus its resolver, so a test can block a cycle deterministically. */
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** Lets already-queued microtasks and zero-delay timers run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  await db.migrate.latest();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await db('oracle_seeds').del();
  await db('worker_cursors').del();
  await db('worker_leases').del();
});

describe('indexer worker — shutdown drain (#1577)', () => {
  const startBlockedIndexer = () => {
    const started = deferred();
    const gate = deferred();
    const soroban = {
      simulate: jest.fn(),
      getLatestLedger: jest.fn(async () => 400),
      getEvents: jest.fn(async () => {
        started.resolve();
        await gate.promise;
        return { events: [], cursor: null };
      }),
    };
    const worker = startIndexerWorker({
      db,
      soroban,
      contractId: COIN_FLIP_ID,
      pollIntervalMs: 100000,
    });
    return { worker, soroban, started, gate };
  };

  test('stop() waits for the in-flight cycle before it resolves', async () => {
    const { worker, started, gate } = startBlockedIndexer();
    await started.promise; // the first cycle is now blocked inside getEvents

    let resolved = false;
    const stopPromise = worker.stop({ deadlineMs: 5000 }).then(() => {
      resolved = true;
    });

    await tick();
    expect(resolved).toBe(false); // still draining the blocked cycle

    gate.resolve();
    await stopPromise;
    expect(resolved).toBe(true);
  });

  test('stop() abandons a cycle that outruns the deadline', async () => {
    const { worker, started, gate } = startBlockedIndexer();
    await started.promise;

    const began = Date.now();
    await worker.stop({ deadlineMs: 50 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(45);

    gate.resolve(); // let the abandoned cycle unwind so nothing is left pending
    await tick();
  });

  test('stop() before the first cycle prevents any cycle from running', async () => {
    const soroban = {
      simulate: jest.fn(),
      getLatestLedger: jest.fn(async () => 400),
      getEvents: jest.fn(async () => ({ events: [], cursor: null })),
    };
    const worker = startIndexerWorker({
      db,
      soroban,
      contractId: COIN_FLIP_ID,
      pollIntervalMs: 100000,
    });

    await worker.stop();
    await tick();
    await tick();

    expect(soroban.getEvents).not.toHaveBeenCalled();
  });

  test('a stopped worker schedules no further cycles', async () => {
    const soroban = {
      simulate: jest.fn(),
      getLatestLedger: jest.fn(async () => 400),
      getEvents: jest.fn(async () => ({ events: [], cursor: null })),
    };
    const worker = startIndexerWorker({
      db,
      soroban,
      contractId: COIN_FLIP_ID,
      pollIntervalMs: 10,
    });

    await tick(); // let the first cycle run and finish
    await worker.stop();
    const callsAfterStop = soroban.getEvents.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(soroban.getEvents.mock.calls.length).toBe(callsAfterStop);
  });
});

describe('oracle worker — shutdown drain (#1577)', () => {
  const startBlockedOracle = () => {
    const started = deferred();
    const gate = deferred();
    const soroban = {
      simulate: jest.fn(async () => {
        started.resolve();
        await gate.promise;
        return 20; // queue already full: no commit transaction
      }),
      getLatestLedger: jest.fn(async () => 400),
      getEvents: jest.fn(async () => ({ events: [], cursor: null })),
      invoke: jest.fn(),
    };
    const worker = startOracleWorker({
      db,
      soroban,
      secretKey: ORACLE.secret(),
      rngContractId: RNG_ID,
      coinFlipContractId: COIN_FLIP_ID,
      minQueue: 20,
      pollIntervalMs: 100000,
    });
    return { worker, soroban, started, gate };
  };

  test('stop() waits for the in-flight cycle before it resolves', async () => {
    const { worker, started, gate } = startBlockedOracle();
    await started.promise; // the first cycle is now blocked inside simulate

    let resolved = false;
    const stopPromise = worker.stop({ deadlineMs: 5000 }).then(() => {
      resolved = true;
    });

    await tick();
    expect(resolved).toBe(false);

    gate.resolve();
    await stopPromise;
    expect(resolved).toBe(true);
  });

  test('stop() abandons a cycle that outruns the deadline', async () => {
    const { worker, started, gate } = startBlockedOracle();
    await started.promise;

    const began = Date.now();
    await worker.stop({ deadlineMs: 50 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(45);

    gate.resolve();
    await tick();
  });
});
