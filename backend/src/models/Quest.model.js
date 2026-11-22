/**
 * Base model for Quests and per-user quest progress.
 */
const db = require('../config/database');
const logger = require('../utils/logger');

const QuestModel = {
  /**
   * Lists the quest catalog (definitions only, no per-user progress).
   *
   * @returns {Promise<Array<{id: number, questId: string, title: string, target: number}>>}
   */
  async listDefinitions() {
    try {
      return await db('quests')
        .select('id', 'quest_id as questId', 'title', 'target')
        .orderBy('id');
    } catch (error) {
      logger.error('Error in QuestModel.listDefinitions:', error);
      throw error;
    }
  },

  /**
   * Lists every quest with this user's progress against it, defaulting to
   * zero/unclaimed for quests the user hasn't touched yet.
   *
   * @param {number} userId
   * @returns {Promise<Array<{questId: string, target: number, progress: number, claimed: boolean, streak: number}>>}
   */
  async getProgressForUser(userId) {
    try {
      return await db('quests')
        .leftJoin('user_quests', function joinOnUser() {
          this.on('user_quests.quest_id', '=', 'quests.id').andOn(
            'user_quests.user_id',
            '=',
            db.raw('?', [userId])
          );
        })
        .select(
          'quests.quest_id as questId',
          'quests.target as target',
          db.raw('COALESCE(user_quests.progress, 0) as progress'),
          db.raw('COALESCE(user_quests.claimed, false) as claimed'),
          db.raw('COALESCE(user_quests.streak, 0) as streak')
        )
        .orderBy('quests.id');
    } catch (error) {
      logger.error('Error in QuestModel.getProgressForUser:', error);
      throw error;
    }
  },

  /**
   * Adds `delta` to a user's progress on a non-repeating quest (e.g.
   * play-5-games), clamped to the quest's target. Completion (progress >=
   * target) is derived from progress only and is deliberately NOT reward
   * settlement: this method never sets `claimed`, which is reserved for an
   * actual payout/mint performed by a separate settlement flow (#1588).
   * A no-op (returns null) if the quest slug doesn't exist; callers are
   * expected to fire-and-forget this, never let a missing quest definition
   * break the action that triggered it.
   *
   * @param {number} userId
   * @param {string} questSlug
   * @param {number} [delta=1]
   * @param {object} [trx] - optional Knex transaction to join (#1580)
   * @returns {Promise<object|null>}
   */
  async recordProgress(userId, questSlug, delta = 1, trx) {
    const database = trx || db;
    try {
      const quest = await database('quests').where({ quest_id: questSlug }).first();
      if (!quest) return null;

      const target = quest.target;
      const initial = Math.min(delta, target);

      /*
       * One statement, so two resolutions that overlap can never read the
       * same starting progress. user_quests.* refers to the pre-update row
       * inside ON CONFLICT, which is what makes the streak transition safe:
       * only the call that actually crosses the target increments it.
       * claimed is deliberately left out of the merge: it means the reward
       * was actually settled by a separate payout flow, so progress tracking
       * must never set it (#1588). CASE rather than LEAST keeps this portable
       * to the SQLite test DB.
       */
      const progressExpr = database.raw('CASE WHEN ?? + ? < ? THEN ?? + ? ELSE ? END', [
        'user_quests.progress',
        delta,
        target,
        'user_quests.progress',
        delta,
        target,
      ]);
      const justCompletedExpr = database.raw('CASE WHEN ?? < ? AND ?? + ? >= ? THEN 1 ELSE 0 END', [
        'user_quests.progress',
        target,
        'user_quests.progress',
        delta,
        target,
      ]);

      const rows = await database('user_quests')
        .insert({
          user_id: userId,
          quest_id: quest.id,
          progress: initial,
          // Completion is not settlement; see #1588.
          claimed: false,
          streak: initial >= target ? 1 : 0,
          updated_at: database.fn.now(),
        })
        .onConflict(['user_id', 'quest_id'])
        .merge({
          progress: progressExpr,
          streak: database.raw('?? + ?', ['user_quests.streak', justCompletedExpr]),
          updated_at: database.fn.now(),
        })
        .returning('*');
      return rows[0];
    } catch (error) {
      logger.error('Error in QuestModel.recordProgress:', error);
      throw error;
    }
  },

  /**
   * Records a daily check-in for the daily-login quest. Calendar-day aware:
   * a second check-in the same day is a no-op, a check-in on the very next
   * calendar day extends the streak, and any bigger gap resets it to 1.
   * Checking in completes the daily objective, but never settles its reward:
   * `claimed` is left untouched for the real payout flow (#1588).
   *
   * @param {number} userId
   * @returns {Promise<object|null>}
   */
  async recordDailyLogin(userId) {
    try {
      const quest = await db('quests').where({ quest_id: 'daily-login' }).first();
      if (!quest) return null;

      /* One UTC-day at a time, formatted so both PostgreSQL and SQLite can
       * compare the timestamp column with a plain string binding. */
      const startOfUtcDay = (date) => `${date.toISOString().slice(0, 10)} 00:00:00`;
      const now = new Date();
      const todayStart = startOfUtcDay(now);
      const tomorrowStart = startOfUtcDay(new Date(now.getTime() + 24 * 60 * 60 * 1000));
      const yesterdayStart = startOfUtcDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      const initial = Math.min(1, quest.target);

      const streakExpr = db.raw('CASE WHEN ?? >= ? AND ?? < ? THEN ?? + 1 ELSE 1 END', [
        'user_quests.updated_at',
        yesterdayStart,
        'user_quests.updated_at',
        todayStart,
        'user_quests.streak',
      ]);

      const rows = await db('user_quests')
        .insert({
          user_id: userId,
          quest_id: quest.id,
          progress: initial,
          // Daily completion is not settlement; see #1588.
          claimed: false,
          streak: 1,
          updated_at: db.fn.now(),
        })
        .onConflict(['user_id', 'quest_id'])
        .merge({
          progress: initial,
          // `claimed` is intentionally not merged, so a settled reward stays
          // settled and an unsettled one is never marked paid by a check-in.
          streak: streakExpr,
          updated_at: db.fn.now(),
        })
        // Same-day calls are a no-op: the merge only runs outside today's window.
        .whereRaw('?? < ? OR ?? >= ?', [
          'user_quests.updated_at',
          todayStart,
          'user_quests.updated_at',
          tomorrowStart,
        ])
        .returning('*');

      if (rows.length > 0) return rows[0];

      // The upsert was skipped because today was already recorded.
      return await db('user_quests').where({ user_id: userId, quest_id: quest.id }).first();
    } catch (error) {
      logger.error('Error in QuestModel.recordDailyLogin:', error);
      throw error;
    }
  },
};

module.exports = QuestModel;
