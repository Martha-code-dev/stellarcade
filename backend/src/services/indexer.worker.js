const StellarSdk = require('@stellar/stellar-sdk');
const logger = require('../utils/logger');

const CURSOR_NAME = 'indexer';
const COIN_FLIP_GAME_TYPE = 'coin-flip';
const DICE_ROLL_GAME_TYPE = 'dice-roll';
const BET_PLACED_TOPIC = 'bet_placed';
const BET_RESOLVED_TOPIC = 'bet_resolved';
const ROLL_PLACED_TOPIC = 'roll_placed';
const ROLL_RESOLVED_TOPIC = 'roll_resolved';
const SIDES = ['heads', 'tails'];
// Stellar asset contracts use 7 decimals: 1 unit = 10^7 stroops.
const STROOP_DECIMALS = 7;

const DEFAULT_POLL_INTERVAL_MS = 5000;
// Upper bound on how long stop() waits for an in-flight cycle during shutdown.
const DEFAULT_SHUTDOWN_DEADLINE_MS = 10000;
const EVENT_PAGE_LIMIT = 100;

/**
 * Per-game event contract. Both games publish a placement and a resolution
 * event with topics [event_name, game_id: u64, player: Address], but their
 * payloads differ. Each entry owns its cursor so the coin-flip and dice-roll
 * streams advance independently and never consume each other's events
 * (#1579). `snapshotMethod` is the view used to rebuild a game whose
 * placement predates the indexer's cursor.
 */
const GAME_DEFINITIONS = {
  [COIN_FLIP_GAME_TYPE]: {
    placedTopic: BET_PLACED_TOPIC,
    resolvedTopic: BET_RESOLVED_TOPIC,
    // Keep the deployed cursor name for the game that was indexed first.
    cursorName: CURSOR_NAME,
    snapshotMethod: 'get_game',
    sideFromData: (data) => SIDES[Number(data.side)] || null,
    sideFromSnapshot: (snapshot) => SIDES[Number(snapshot.side)] || null,
  },
  [DICE_ROLL_GAME_TYPE]: {
    placedTopic: ROLL_PLACED_TOPIC,
    resolvedTopic: ROLL_RESOLVED_TOPIC,
    cursorName: 'indexer:dice-roll',
    snapshotMethod: 'get_roll',
    // A prediction is the predicted face (1..6). Stored as a string so the
    // shared `side` column holds both "heads"/"tails" and a die face.
    sideFromData: (data) => String(data.prediction),
    sideFromSnapshot: (snapshot) => String(snapshot.prediction),
  },
};

const symbolTopic = (name) => StellarSdk.xdr.ScVal.scvSymbol(name).toXDR('base64');

/**
 * Converts an integer stroop amount to an exact decimal string in token units
 * (e.g. 25000000n → "2.5000000"). No floating point is involved.
 *
 * @param {bigint|number|string} stroops
 * @returns {string}
 */
const stroopsToUnits = (stroops) => {
  const value = BigInt(stroops);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(STROOP_DECIMALS + 1, '0');
  const whole = digits.slice(0, -STROOP_DECIMALS);
  const fraction = digits.slice(-STROOP_DECIMALS);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
};

const normalizeTxHash = (hash) => {
  const normalized = String(hash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    const error = new Error(`Event carries an invalid transaction hash: ${hash}`);
    error.code = 'INVALID_TX_HASH';
    throw error;
  }
  return normalized;
};

const loadCursor = async (db, name) => {
  const row = await db('worker_cursors').where({ name }).first();
  return row ? row.cursor : null;
};

const saveCursor = async (database, name, cursor) => {
  await database('worker_cursors')
    .insert({ name, cursor, updated_at: database.fn.now() })
    .onConflict('name')
    .merge({ cursor, updated_at: database.fn.now() });
};

/**
 * Decodes one game event against a game definition. Returns null for a topic
 * that is not that game's placement or resolution event.
 *
 * @param {object} game - an entry from GAME_DEFINITIONS
 * @param {object} event - Soroban event
 * @returns {{name: string, gameId: string, player: string, data: object}|null}
 */
const decodeGameEvent = (game, event) => {
  const [nameVal, gameIdVal, playerVal] = event.topic;
  const name = StellarSdk.scValToNative(nameVal);
  if (name !== game.placedTopic && name !== game.resolvedTopic) {
    return null;
  }
  return {
    name,
    gameId: StellarSdk.scValToNative(gameIdVal).toString(),
    player: StellarSdk.scValToNative(playerVal),
    data: StellarSdk.scValToNative(event.value),
  };
};

/**
 * Decodes a coin-flip BetPlaced / BetResolved event.
 * Topics: [bet_placed | bet_resolved, game_id: u64, player: Address]
 * Data: BetPlaced { side: u32, wager: i128 }, BetResolved { won: bool, payout: i128 }
 */
const decodeCoinFlipEvent = (event) =>
  decodeGameEvent(GAME_DEFINITIONS[COIN_FLIP_GAME_TYPE], event);

/**
 * Decodes a dice-roll RollPlaced / RollResolved event.
 * Topics: [roll_placed | roll_resolved, game_id: u64, player: Address]
 * Data: RollPlaced { prediction: u32, wager: i128 },
 *       RollResolved { result: u32, won: bool, payout: i128 }
 */
const decodeDiceRollEvent = (event) =>
  decodeGameEvent(GAME_DEFINITIONS[DICE_ROLL_GAME_TYPE], event);

/**
 * Resolves which game contracts to index and their start ledger. The
 * coin-flip contract stays configurable through the legacy `contractId`
 * option so existing callers keep working (#1579).
 */
const resolveConfig = (options = {}) => {
  const coinFlipContractId =
    options.contractId || options.coinFlipContractId || process.env.COIN_FLIP_CONTRACT_ID;
  const diceRollContractId = options.diceRollContractId ?? process.env.DICE_ROLL_CONTRACT_ID;

  const games = [];
  if (coinFlipContractId) {
    games.push({ gameType: COIN_FLIP_GAME_TYPE, contractId: coinFlipContractId });
  }
  if (diceRollContractId) {
    games.push({ gameType: DICE_ROLL_GAME_TYPE, contractId: diceRollContractId });
  }
  if (games.length === 0) {
    const error = new Error(
      'Indexer worker is not configured: set COIN_FLIP_CONTRACT_ID and/or DICE_ROLL_CONTRACT_ID'
    );
    error.code = 'INDEXER_NOT_CONFIGURED';
    throw error;
  }

  const startLedger = options.startLedger ?? process.env.INDEXER_START_LEDGER;
  return { games, startLedger: startLedger ? Number(startLedger) : null };
};

/**
 * Creates the indexer's operations. `db`, `soroban`, `GameModel`, `UserModel`
 * and `QuestModel` are injectable for tests; they default to the real modules.
 */
const createIndexer = (options = {}) => {
  const config = resolveConfig(options);
  const db = options.db || require('../config/database');
  const soroban = options.soroban || require('./soroban.service');
  const GameModel = options.GameModel || require('../models/Game.model');
  const UserModel = options.UserModel || require('../models/User.model');
  const QuestModel = options.QuestModel || require('../models/Quest.model');
  // Each configured contract is indexed against its own event definition.
  const games = config.games.map((game) => ({
    ...game,
    ...GAME_DEFINITIONS[game.gameType],
  }));

  const findUserId = async (walletAddress, trx) => {
    if (trx) {
      // Inside #1580's per-event transaction every read must use the same
      // connection. UserModel.findByWallet uses the module db, which would
      // deadlock a single-connection SQLite test database.
      const user = await trx('users').where({ wallet_address: walletAddress }).first();
      return user ? user.id : null;
    }
    const user = await UserModel.findByWallet(walletAddress);
    return user ? user.id : null;
  };

  const placedRow = (game, { gameId, player, side, wager, userId, txHash, ledger, closedAt }) => ({
    contract_id: game.contractId,
    chain_game_id: gameId,
    player_address: player,
    user_id: userId,
    game_type: game.gameType,
    side,
    bet_amount: stroopsToUnits(wager),
    payout: '0.0000000',
    result: 'pending',
    status: 'pending',
    tx_hash: txHash,
    ledger,
    ...(closedAt ? { created_at: new Date(closedAt) } : {}),
  });

  const handlePlaced = async (game, event, decoded, trx) => {
    await GameModel.insertChainGame(
      placedRow(game, {
        gameId: decoded.gameId,
        player: decoded.player,
        side: game.sideFromData(decoded.data),
        wager: decoded.data.wager,
        userId: await findUserId(decoded.player, trx),
        txHash: normalizeTxHash(event.txHash),
        ledger: event.ledger,
        closedAt: event.ledgerClosedAt,
      }),
      trx
    );
  };

  /**
   * Records quest progress for a game that just moved to resolved. Runs only
   * on that transition, so replays never count a game twice. Failures must
   * propagate: the caller rolls the whole event back so a later replay can
   * credit the game instead of silently losing the progress (#1580).
   */
  const recordQuestProgress = async (game, trx) => {
    if (!game.user_id) return;
    await QuestModel.recordProgress(game.user_id, 'play-5-games', 1, trx);
    if (game.result === 'win') {
      await QuestModel.recordProgress(game.user_id, 'win-3-games', 1, trx);
    }
  };

  const handleResolved = async (game, event, decoded, trx) => {
    const { gameId, player, data } = decoded;
    let existing = await GameModel.findByChainGame(game.contractId, gameId, trx);

    if (!existing) {
      // Placement predates the indexer's start ledger: read the game from the
      // contract instead of guessing. The placing transaction is unknown, so
      // tx_hash stays null.
      const snapshot = await soroban.simulate(game.contractId, game.snapshotMethod, [
        StellarSdk.nativeToScVal(BigInt(gameId), { type: 'u64' }),
      ]);
      await GameModel.insertChainGame(
        placedRow(game, {
          gameId,
          player,
          side: game.sideFromSnapshot(snapshot),
          wager: snapshot.wager,
          userId: await findUserId(player, trx),
          txHash: null,
          ledger: null,
          closedAt: null,
        }),
        trx
      );
      existing = await GameModel.findByChainGame(game.contractId, gameId, trx);
    }

    const patch = {
      result: data.won ? 'win' : 'loss',
      payout: stroopsToUnits(data.payout),
      resolve_tx_hash: normalizeTxHash(event.txHash),
      resolved_at: event.ledgerClosedAt ? new Date(event.ledgerClosedAt) : new Date(),
    };
    if (!existing.user_id) {
      // The player may have created an account after placing the game.
      const userId = await findUserId(player, trx);
      if (userId) patch.user_id = userId;
    }

    const resolved = await GameModel.resolveChainGame(game.contractId, gameId, patch, trx);
    if (resolved) {
      await recordQuestProgress(resolved, trx);
    }
  };

  const handleEvent = async (game, event, trx) => {
    if (event.inSuccessfulContractCall === false) return;
    const decoded = decodeGameEvent(game, event);
    if (!decoded) return;
    if (decoded.name === game.placedTopic) {
      await handlePlaced(game, event, decoded, trx);
    } else {
      await handleResolved(game, event, decoded, trx);
    }
  };

  /**
   * Polls one game's events from its own saved cursor, saving the cursor
   * after every event so a restart resumes where processing stopped.
   *
   * @param {object} game - resolved game definition
   * @returns {Promise<number>} number of events handled
   */
  const processGameEvents = async (game) => {
    const cursor = await loadCursor(db, game.cursorName);
    const query = {
      contractIds: [game.contractId],
      topics: [
        [symbolTopic(game.placedTopic), '*', '*'],
        [symbolTopic(game.resolvedTopic), '*', '*'],
      ],
      limit: EVENT_PAGE_LIMIT,
    };
    if (cursor) {
      query.cursor = cursor;
    } else {
      query.startLedger = config.startLedger || (await soroban.getLatestLedger());
    }

    const { events, cursor: nextCursor } = await soroban.getEvents(query);
    let handled = 0;
    for (const event of events) {
      // One event is one atomic unit: its game write, quest credit and cursor
      // advance either all commit or all roll back. A crash at any boundary
      // replays the event and yields exactly one credit (#1580).
      await db.transaction(async (trx) => {
        await handleEvent(game, event, trx);
        await saveCursor(trx, game.cursorName, event.id);
      });
      handled += 1;
    }
    if (nextCursor) {
      await saveCursor(db, game.cursorName, nextCursor);
    }
    return handled;
  };

  /**
   * Polls every configured game. Each game keeps its own cursor, so a backlog
   * on one never blocks the other and their game ids never collide (#1579).
   *
   * @returns {Promise<number>} number of events handled across all games
   */
  const processEvents = async () => {
    let handled = 0;
    for (const game of games) {
      handled += await processGameEvents(game);
    }
    return handled;
  };

  const runCycle = async () => {
    try {
      await processEvents();
    } catch (err) {
      logger.error('Indexer event processing failed', { error: err.message, code: err.code });
    }
  };

  return { processEvents, handleEvent, runCycle, config };
};

/**
 * Starts the indexer polling loop. Cycles never overlap.
 *
 * @param {object} [options]
 * @param {number} [options.pollIntervalMs] - Defaults to INDEXER_POLL_INTERVAL_MS or 5000.
 * @returns {{ stop: (opts?: {deadlineMs?: number}) => Promise<void> }}
 */
const startIndexerWorker = (options = {}) => {
  const indexer = createIndexer(options);
  const pollIntervalMs =
    Number(options.pollIntervalMs || process.env.INDEXER_POLL_INTERVAL_MS) ||
    DEFAULT_POLL_INTERVAL_MS;
  const shutdownDeadlineMs =
    Number(options.shutdownDeadlineMs) || DEFAULT_SHUTDOWN_DEADLINE_MS;

  let stopped = false;
  let timer = null;
  // The cycle currently in flight, so stop() can wait for it before the caller
  // closes the database or RPC connection (#1577).
  let inFlight = null;

  const loop = async () => {
    if (stopped) return;
    inFlight = indexer.runCycle();
    try {
      await inFlight;
    } finally {
      inFlight = null;
      if (!stopped) {
        timer = setTimeout(loop, pollIntervalMs);
      }
    }
  };

  logger.info('Starting game indexer worker', {
    games: indexer.config.games,
    pollIntervalMs,
  });
  timer = setTimeout(loop, 0);

  return {
    /**
     * Stops scheduling new cycles and drains the one already running, so the
     * caller can close shared dependencies without pulling them out from under
     * an in-flight write. Bounded by `deadlineMs`: a cycle that will not finish
     * in time is abandoned and shutdown proceeds (#1577).
     *
     * @param {object} [opts]
     * @param {number} [opts.deadlineMs] - Max time to wait for the in-flight cycle.
     * @returns {Promise<void>}
     */
    async stop({ deadlineMs = shutdownDeadlineMs } = {}) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!inFlight) return;

      const drained = inFlight.catch(() => {});
      let deadlineTimer;
      await Promise.race([
        drained,
        new Promise((resolve) => {
          deadlineTimer = setTimeout(resolve, deadlineMs);
        }),
      ]);
      clearTimeout(deadlineTimer);
    },
  };
};

module.exports = {
  startIndexerWorker,
  createIndexer,
  decodeCoinFlipEvent,
  decodeDiceRollEvent,
  stroopsToUnits,
};
