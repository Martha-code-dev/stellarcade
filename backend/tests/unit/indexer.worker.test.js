/**
 * Unit tests for the coin-flip event indexer, run against the in-memory
 * SQLite database from tests/setup.js (real migrations, real Game/User/Quest
 * models) with a stubbed Soroban RPC.
 */
const StellarSdk = require('@stellar/stellar-sdk');

const mockLogger = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock('../../src/utils/logger', () => mockLogger);

const db = require('../../src/config/database');
const { createIndexer, stroopsToUnits } = require('../../src/services/indexer.worker');

const COIN_FLIP_ID = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 2));
const DICE_ROLL_ID = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 3));
const LINKED_PLAYER = StellarSdk.Keypair.random().publicKey();
const ANON_PLAYER = StellarSdk.Keypair.random().publicKey();
const PLACE_TX = '1f'.repeat(32);
const RESOLVE_TX = '2e'.repeat(32);

const entry = (key, val) =>
  new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol(key), val });

const topics = (name, gameId, player) => [
  StellarSdk.xdr.ScVal.scvSymbol(name),
  StellarSdk.nativeToScVal(BigInt(gameId), { type: 'u64' }),
  new StellarSdk.Address(player).toScVal(),
];

/** BetPlaced exactly as coin-flip emits it: data map { side: u32, wager: i128 }. */
const betPlaced = ({ id, gameId, player, side = 0, wager = 25_000_000n }) => ({
  id,
  txHash: PLACE_TX,
  ledger: 500,
  ledgerClosedAt: '2026-10-01T12:00:00Z',
  inSuccessfulContractCall: true,
  topic: topics('bet_placed', gameId, player),
  value: StellarSdk.xdr.ScVal.scvMap([
    entry('side', StellarSdk.nativeToScVal(side, { type: 'u32' })),
    entry('wager', StellarSdk.nativeToScVal(wager, { type: 'i128' })),
  ]),
});

/** BetResolved: data map { payout: i128, won: bool }. */
const betResolved = ({ id, gameId, player, won = true, payout = 49_000_000n }) => ({
  id,
  txHash: RESOLVE_TX,
  ledger: 502,
  ledgerClosedAt: '2026-10-01T12:00:10Z',
  inSuccessfulContractCall: true,
  topic: topics('bet_resolved', gameId, player),
  value: StellarSdk.xdr.ScVal.scvMap([
    entry('payout', StellarSdk.nativeToScVal(payout, { type: 'i128' })),
    entry('won', StellarSdk.xdr.ScVal.scvBool(won)),
  ]),
});

/** RollPlaced exactly as dice-roll emits it: data map { prediction: u32, wager: i128 }. */
const rollPlaced = ({ id, gameId, player, prediction = 3, wager = 10_000_000n }) => ({
  id,
  txHash: PLACE_TX,
  ledger: 500,
  ledgerClosedAt: '2026-10-01T12:00:00Z',
  inSuccessfulContractCall: true,
  topic: topics('roll_placed', gameId, player),
  value: StellarSdk.xdr.ScVal.scvMap([
    entry('prediction', StellarSdk.nativeToScVal(prediction, { type: 'u32' })),
    entry('wager', StellarSdk.nativeToScVal(wager, { type: 'i128' })),
  ]),
});

/** RollResolved: data map { result: u32, won: bool, payout: i128 }. */
const rollResolved = ({ id, gameId, player, result = 3, won = true, payout = 19_000_000n }) => ({
  id,
  txHash: RESOLVE_TX,
  ledger: 502,
  ledgerClosedAt: '2026-10-01T12:00:10Z',
  inSuccessfulContractCall: true,
  topic: topics('roll_resolved', gameId, player),
  value: StellarSdk.xdr.ScVal.scvMap([
    entry('result', StellarSdk.nativeToScVal(result, { type: 'u32' })),
    entry('won', StellarSdk.xdr.ScVal.scvBool(won)),
    entry('payout', StellarSdk.nativeToScVal(payout, { type: 'i128' })),
  ]),
});

const makeSoroban = (pages = []) => ({
  simulate: jest.fn(),
  getLatestLedger: jest.fn(async () => 400),
  getEvents: jest.fn(async () => pages.shift() || { events: [], cursor: null }),
});

/** A stub that serves a separate page queue per contract id. */
const makeMultiSoroban = (pagesByContract = {}) => ({
  simulate: jest.fn(),
  getLatestLedger: jest.fn(async () => 400),
  getEvents: jest.fn(async (query) => {
    const queue = pagesByContract[query.contractIds[0]] || [];
    return queue.shift() || { events: [], cursor: null };
  }),
});

const makeIndexer = (soroban, options = {}) =>
  createIndexer({ db, soroban, contractId: COIN_FLIP_ID, ...options });

/** Indexes coin-flip and dice-roll together, each on its own contract. */
const makeMultiIndexer = (soroban, options = {}) =>
  createIndexer({
    db,
    soroban,
    contractId: COIN_FLIP_ID,
    diceRollContractId: DICE_ROLL_ID,
    ...options,
  });

const gameRow = (gameId) =>
  db('games').where({ contract_id: COIN_FLIP_ID, chain_game_id: gameId }).first();

const diceRow = (gameId) =>
  db('games').where({ contract_id: DICE_ROLL_ID, chain_game_id: gameId }).first();

const cursorRow = (name) => db('worker_cursors').where({ name }).first();

const questProgress = async (userId, slug) => {
  const row = await db('user_quests')
    .join('quests', 'user_quests.quest_id', 'quests.id')
    .where({ 'user_quests.user_id': userId, 'quests.quest_id': slug })
    .first('user_quests.progress');
  return row ? row.progress : 0;
};

let linkedUserId;

beforeAll(async () => {
  await db.migrate.latest();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await db('user_quests').del();
  await db('games').del();
  await db('users').del();
  await db('worker_cursors').del();
  [linkedUserId] = (
    await db('users').insert({ wallet_address: LINKED_PLAYER }).returning('id')
  ).map((r) => (typeof r === 'object' ? r.id : r));
});

afterAll(async () => {
  await db.destroy();
});

describe('indexer worker', () => {
  test('BetPlaced creates a pending row with the real tx hash', async () => {
    const soroban = makeSoroban([
      {
        events: [betPlaced({ id: 'e1', gameId: 11, player: LINKED_PLAYER, side: 1 })],
        cursor: 'e1',
      },
    ]);

    await makeIndexer(soroban).processEvents();

    const row = await gameRow('11');
    expect(row).toMatchObject({
      contract_id: COIN_FLIP_ID,
      player_address: LINKED_PLAYER,
      user_id: linkedUserId,
      game_type: 'coin-flip',
      side: 'tails',
      result: 'pending',
      status: 'pending',
      tx_hash: PLACE_TX,
      ledger: 500,
    });
    expect(row.tx_hash).toHaveLength(64);
    expect(row.tx_hash.startsWith('0x')).toBe(false);
    expect(Number(row.bet_amount)).toBe(2.5);
  });

  test('BetResolved updates the same row and records quest progress', async () => {
    const soroban = makeSoroban([
      {
        events: [
          betPlaced({ id: 'e1', gameId: 12, player: LINKED_PLAYER }),
          betResolved({ id: 'e2', gameId: 12, player: LINKED_PLAYER, won: true }),
        ],
        cursor: 'e2',
      },
    ]);

    await makeIndexer(soroban).processEvents();

    expect(await db('games').count('* as n').first()).toMatchObject({ n: 1 });
    const row = await gameRow('12');
    expect(row).toMatchObject({
      status: 'resolved',
      result: 'win',
      tx_hash: PLACE_TX,
      resolve_tx_hash: RESOLVE_TX,
    });
    expect(Number(row.payout)).toBe(4.9);
    expect(await questProgress(linkedUserId, 'play-5-games')).toBe(1);
    expect(await questProgress(linkedUserId, 'win-3-games')).toBe(1);
  });

  test('a lost bet counts toward play-5-games but not win-3-games', async () => {
    const soroban = makeSoroban([
      {
        events: [
          betPlaced({ id: 'e1', gameId: 13, player: LINKED_PLAYER }),
          betResolved({ id: 'e2', gameId: 13, player: LINKED_PLAYER, won: false, payout: 0n }),
        ],
        cursor: 'e2',
      },
    ]);

    await makeIndexer(soroban).processEvents();

    expect((await gameRow('13')).result).toBe('loss');
    expect(await questProgress(linkedUserId, 'play-5-games')).toBe(1);
    expect(await questProgress(linkedUserId, 'win-3-games')).toBe(0);
  });

  test('replaying a batch of events is idempotent, including quest progress', async () => {
    const batch = () => [
      betPlaced({ id: 'e1', gameId: 14, player: LINKED_PLAYER }),
      betResolved({ id: 'e2', gameId: 14, player: LINKED_PLAYER, won: true }),
    ];
    await makeIndexer(makeSoroban([{ events: batch(), cursor: 'e2' }])).processEvents();
    const before = await gameRow('14');

    // Lose the cursor so the same events are delivered again.
    await db('worker_cursors').del();
    await makeIndexer(makeSoroban([{ events: batch(), cursor: 'e2' }])).processEvents();

    expect(await db('games').count('* as n').first()).toMatchObject({ n: 1 });
    expect(await gameRow('14')).toEqual(before);
    expect(await questProgress(linkedUserId, 'play-5-games')).toBe(1);
    expect(await questProgress(linkedUserId, 'win-3-games')).toBe(1);
  });

  test('a quest-credit failure rolls back the resolution and cursor, so a retry credits exactly once (#1580)', async () => {
    const RealQuestModel = require('../../src/models/Quest.model');
    const batch = () => [
      betPlaced({ id: 'e1', gameId: 18, player: LINKED_PLAYER }),
      betResolved({ id: 'e2', gameId: 18, player: LINKED_PLAYER, won: true }),
    ];

    // First attempt: the quest write fails on the resolution event.
    const failingQuest = {
      recordProgress: jest.fn(async () => {
        throw new Error('quest store temporarily unavailable');
      }),
    };
    await expect(
      makeIndexer(makeSoroban([{ events: batch(), cursor: 'e2' }]), { QuestModel: failingQuest })
        .processEvents()
    ).rejects.toThrow('quest store temporarily unavailable');

    // The failed event committed nothing: the game is still pending, no quest
    // credit was given, and the cursor stayed at the last successful event.
    expect((await gameRow('18')).status).toBe('pending');
    expect(await questProgress(linkedUserId, 'play-5-games')).toBe(0);
    expect(await db('worker_cursors').where({ name: 'indexer' }).first()).toMatchObject({
      cursor: 'e1',
    });

    // Retry with a working quest store: exactly one credit, cursor now advanced.
    await makeIndexer(
      makeSoroban([{ events: batch(), cursor: 'e2' }]),
      { QuestModel: RealQuestModel }
    ).processEvents();

    expect((await gameRow('18')).status).toBe('resolved');
    expect(await questProgress(linkedUserId, 'play-5-games')).toBe(1);
    expect(await questProgress(linkedUserId, 'win-3-games')).toBe(1);
    expect(await db('worker_cursors').where({ name: 'indexer' }).first()).toMatchObject({
      cursor: 'e2',
    });
  });

  test('an event from a wallet with no user account is still indexed', async () => {
    const soroban = makeSoroban([
      {
        events: [
          betPlaced({ id: 'e1', gameId: 15, player: ANON_PLAYER }),
          betResolved({ id: 'e2', gameId: 15, player: ANON_PLAYER }),
        ],
        cursor: 'e2',
      },
    ]);

    await makeIndexer(soroban).processEvents();

    const row = await gameRow('15');
    expect(row).toMatchObject({ player_address: ANON_PLAYER, user_id: null, status: 'resolved' });
    expect(await db('user_quests').count('* as n').first()).toMatchObject({ n: 0 });

    // And it shows up in /games/recent with the on-chain address as user_wallet.
    const GameModel = require('../../src/models/Game.model');
    const { items } = await GameModel.findRecent({ page: 1, limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0].user_wallet).toBe(ANON_PLAYER);
  });

  test('resumes from the saved cursor after a restart', async () => {
    const first = makeSoroban([
      { events: [betPlaced({ id: 'e1', gameId: 16, player: LINKED_PLAYER })], cursor: 'e1' },
    ]);
    await makeIndexer(first).processEvents();
    expect(first.getEvents.mock.calls[0][0]).toMatchObject({ startLedger: 400 });

    const second = makeSoroban([{ events: [], cursor: 'e1' }]);
    await makeIndexer(second).processEvents();
    expect(second.getEvents.mock.calls[0][0]).toMatchObject({ cursor: 'e1' });
    expect(second.getEvents.mock.calls[0][0].startLedger).toBeUndefined();
  });

  test('BetResolved for a bet placed before the start ledger reads the bet from the contract', async () => {
    const soroban = makeSoroban([
      {
        events: [
          betResolved({ id: 'e1', gameId: 17, player: ANON_PLAYER, won: false, payout: 0n }),
        ],
        cursor: 'e1',
      },
    ]);
    soroban.simulate.mockResolvedValue({
      player: ANON_PLAYER,
      side: 0,
      wager: 10_000_000n,
      resolved: true,
      won: false,
      payout: 0n,
    });

    await makeIndexer(soroban).processEvents();

    expect(soroban.simulate).toHaveBeenCalledWith(COIN_FLIP_ID, 'get_game', expect.any(Array));
    const row = await gameRow('17');
    expect(row).toMatchObject({ status: 'resolved', result: 'loss', side: 'heads', tx_hash: null });
    expect(Number(row.bet_amount)).toBe(1);
  });
});

describe('indexer worker — dice-roll (#1579)', () => {
  test('RollPlaced creates a pending dice row with the predicted face', async () => {
    const soroban = makeMultiSoroban({
      [DICE_ROLL_ID]: [
        {
          events: [rollPlaced({ id: 'd1', gameId: 21, player: LINKED_PLAYER, prediction: 5 })],
          cursor: 'd1',
        },
      ],
    });

    await makeMultiIndexer(soroban).processEvents();

    const row = await diceRow('21');
    expect(row).toMatchObject({
      contract_id: DICE_ROLL_ID,
      player_address: LINKED_PLAYER,
      user_id: linkedUserId,
      game_type: 'dice-roll',
      side: '5',
      result: 'pending',
      status: 'pending',
      tx_hash: PLACE_TX,
      ledger: 500,
    });
    expect(Number(row.bet_amount)).toBe(1);
    // The coin-flip stream is untouched.
    expect(await db('games').where({ contract_id: COIN_FLIP_ID }).first()).toBeUndefined();
  });

  test('RollResolved updates the dice row once and records quest progress', async () => {
    const soroban = makeMultiSoroban({
      [DICE_ROLL_ID]: [
        {
          events: [
            rollPlaced({ id: 'd1', gameId: 22, player: LINKED_PLAYER, prediction: 2 }),
            rollResolved({ id: 'd2', gameId: 22, player: LINKED_PLAYER, result: 2, won: true }),
          ],
          cursor: 'd2',
        },
      ],
    });

    await makeMultiIndexer(soroban).processEvents();

    const row = await diceRow('22');
    expect(row).toMatchObject({ status: 'resolved', result: 'win', resolve_tx_hash: RESOLVE_TX });
    expect(Number(row.payout)).toBe(1.9);
    expect(await questProgress(linkedUserId, 'play-5-games')).toBe(1);
    expect(await questProgress(linkedUserId, 'win-3-games')).toBe(1);
  });

  test('a lost dice roll counts toward play-5-games but not win-3-games', async () => {
    const soroban = makeMultiSoroban({
      [DICE_ROLL_ID]: [
        {
          events: [
            rollPlaced({ id: 'd1', gameId: 23, player: LINKED_PLAYER, prediction: 6 }),
            rollResolved({
              id: 'd2',
              gameId: 23,
              player: LINKED_PLAYER,
              result: 1,
              won: false,
              payout: 0n,
            }),
          ],
          cursor: 'd2',
        },
      ],
    });

    await makeMultiIndexer(soroban).processEvents();

    expect((await diceRow('23')).result).toBe('loss');
    expect(await questProgress(linkedUserId, 'play-5-games')).toBe(1);
    expect(await questProgress(linkedUserId, 'win-3-games')).toBe(0);
  });

  test('a coin-flip and a dice-roll game with the same id stay distinct rows', async () => {
    const soroban = makeMultiSoroban({
      [COIN_FLIP_ID]: [
        {
          events: [betPlaced({ id: 'c1', gameId: 7, player: LINKED_PLAYER, side: 1 })],
          cursor: 'c1',
        },
      ],
      [DICE_ROLL_ID]: [
        {
          events: [rollPlaced({ id: 'd1', gameId: 7, player: LINKED_PLAYER, prediction: 4 })],
          cursor: 'd1',
        },
      ],
    });

    await makeMultiIndexer(soroban).processEvents();

    expect(await db('games').count('* as n').first()).toMatchObject({ n: 2 });
    expect(await gameRow('7')).toMatchObject({ game_type: 'coin-flip', side: 'tails' });
    expect(await diceRow('7')).toMatchObject({ game_type: 'dice-roll', side: '4' });
  });

  test('coin-flip and dice-roll keep independent cursors', async () => {
    const soroban = makeMultiSoroban({
      [COIN_FLIP_ID]: [
        { events: [betPlaced({ id: 'c1', gameId: 31, player: LINKED_PLAYER })], cursor: 'c1' },
      ],
      [DICE_ROLL_ID]: [
        { events: [rollPlaced({ id: 'd1', gameId: 41, player: LINKED_PLAYER })], cursor: 'd1' },
      ],
    });

    await makeMultiIndexer(soroban).processEvents();

    expect(await cursorRow('indexer')).toMatchObject({ cursor: 'c1' });
    expect(await cursorRow('indexer:dice-roll')).toMatchObject({ cursor: 'd1' });
  });

  test('resumes each game from its own saved cursor after a restart', async () => {
    const first = makeMultiSoroban({
      [COIN_FLIP_ID]: [
        { events: [betPlaced({ id: 'c1', gameId: 51, player: LINKED_PLAYER })], cursor: 'c1' },
      ],
      [DICE_ROLL_ID]: [
        { events: [rollPlaced({ id: 'd1', gameId: 61, player: LINKED_PLAYER })], cursor: 'd1' },
      ],
    });
    await makeMultiIndexer(first).processEvents();

    const second = makeMultiSoroban({
      [COIN_FLIP_ID]: [{ events: [], cursor: 'c1' }],
      [DICE_ROLL_ID]: [{ events: [], cursor: 'd1' }],
    });
    await makeMultiIndexer(second).processEvents();

    const queriesFor = (id) =>
      second.getEvents.mock.calls.map(([q]) => q).filter((q) => q.contractIds[0] === id);
    expect(queriesFor(COIN_FLIP_ID)[0]).toMatchObject({ cursor: 'c1' });
    expect(queriesFor(COIN_FLIP_ID)[0].startLedger).toBeUndefined();
    expect(queriesFor(DICE_ROLL_ID)[0]).toMatchObject({ cursor: 'd1' });
    expect(queriesFor(DICE_ROLL_ID)[0].startLedger).toBeUndefined();
  });

  test('replaying a dice batch is idempotent, including quest progress', async () => {
    const batch = () => [
      rollPlaced({ id: 'd1', gameId: 71, player: LINKED_PLAYER, prediction: 3 }),
      rollResolved({ id: 'd2', gameId: 71, player: LINKED_PLAYER, result: 3, won: true }),
    ];
    await makeMultiIndexer(
      makeMultiSoroban({ [DICE_ROLL_ID]: [{ events: batch(), cursor: 'd2' }] })
    ).processEvents();
    const before = await diceRow('71');

    // Lose the dice cursor so the same events are delivered again.
    await db('worker_cursors').where({ name: 'indexer:dice-roll' }).del();
    await makeMultiIndexer(
      makeMultiSoroban({ [DICE_ROLL_ID]: [{ events: batch(), cursor: 'd2' }] })
    ).processEvents();

    expect(
      await db('games').where({ contract_id: DICE_ROLL_ID }).count('* as n').first()
    ).toMatchObject({ n: 1 });
    expect(await diceRow('71')).toEqual(before);
    expect(await questProgress(linkedUserId, 'play-5-games')).toBe(1);
    expect(await questProgress(linkedUserId, 'win-3-games')).toBe(1);
  });

  test('RollResolved for a roll placed before the start ledger reads the roll from the contract', async () => {
    const soroban = makeMultiSoroban({
      [DICE_ROLL_ID]: [
        {
          events: [
            rollResolved({
              id: 'd1',
              gameId: 81,
              player: ANON_PLAYER,
              result: 4,
              won: false,
              payout: 0n,
            }),
          ],
          cursor: 'd1',
        },
      ],
    });
    soroban.simulate.mockResolvedValue({
      player: ANON_PLAYER,
      prediction: 4,
      wager: 5_000_000n,
      resolved: true,
      won: false,
      result: 1,
      payout: 0n,
    });

    await makeMultiIndexer(soroban).processEvents();

    expect(soroban.simulate).toHaveBeenCalledWith(DICE_ROLL_ID, 'get_roll', expect.any(Array));
    const row = await diceRow('81');
    expect(row).toMatchObject({
      status: 'resolved',
      result: 'loss',
      side: '4',
      tx_hash: null,
      user_id: null,
    });
    expect(Number(row.bet_amount)).toBe(0.5);
  });

  test('coin-flip and dice-roll resolution both appear in the shared history and leaderboard', async () => {
    const soroban = makeMultiSoroban({
      [COIN_FLIP_ID]: [
        {
          events: [
            betPlaced({ id: 'c1', gameId: 91, player: LINKED_PLAYER }),
            betResolved({
              id: 'c2',
              gameId: 91,
              player: LINKED_PLAYER,
              won: true,
              payout: 49_000_000n,
            }),
          ],
          cursor: 'c2',
        },
      ],
      [DICE_ROLL_ID]: [
        {
          events: [
            rollPlaced({ id: 'd1', gameId: 92, player: LINKED_PLAYER, prediction: 2 }),
            rollResolved({
              id: 'd2',
              gameId: 92,
              player: LINKED_PLAYER,
              result: 2,
              won: true,
              payout: 19_000_000n,
            }),
          ],
          cursor: 'd2',
        },
      ],
    });

    await makeMultiIndexer(soroban).processEvents();

    const GameModel = require('../../src/models/Game.model');
    const { items } = await GameModel.findRecent({ page: 1, limit: 10 });
    expect(items.map((g) => g.game_type).sort()).toEqual(['coin-flip', 'dice-roll']);

    const leaderboard = await GameModel.getLeaderboard({ limit: 10 });
    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0].playerAddress).toBe(LINKED_PLAYER);
    expect(leaderboard[0].gamesPlayed).toBe(2);
    // net = (4.9 - 2.5) + (1.9 - 1.0) = 3.3
    expect(Number(leaderboard[0].score)).toBeCloseTo(3.3, 7);
  });
});

describe('stroopsToUnits', () => {
  test('converts exactly without floating point', () => {
    expect(stroopsToUnits(25_000_000n)).toBe('2.5000000');
    expect(stroopsToUnits(1n)).toBe('0.0000001');
    expect(stroopsToUnits(0n)).toBe('0.0000000');
    expect(stroopsToUnits(123456789012345678901n)).toBe('12345678901234.5678901');
  });
});
