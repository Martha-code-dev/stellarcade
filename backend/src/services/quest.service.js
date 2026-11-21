const UserModel = require('../models/User.model');
const QuestModel = require('../models/Quest.model');

/**
 * Service for managing quest-related business logic.
 *
 * Quest state has three deliberately separate meanings (#1588):
 *  - completed: progress >= target. Derived from progress, and recomputed by
 *    web consumers from progress. Earning the objective is not a payout.
 *  - claimable: completed && !claimed, i.e. eligible for a reward that has
 *    not been paid yet. Web gates this behind future XP/badge minting.
 *  - claimed (settled): the reward was actually paid or minted. Only a real
 *    settlement flow may set it; progress writes and daily login never do.
 *
 * This mapping exposes `claimed` unchanged from persistence so an earned
 * quest is never presented to consumers as an already-settled payout.
 */
const questService = {
  /**
   * Returns every quest with this player's progress against it. Players who
   * haven't linked an account yet (or have no progress rows) still see the
   * full quest catalog, just at zero/unclaimed, never a 404 or an empty list.
   *
   * This is a public read. It deliberately has no side effects: a daily
   * check-in is an explicit, owner-authenticated mutation (see
   * `checkInDaily`), so viewing another player's progress cannot extend
   * their streak and viewing your own cannot do it by accident.
   *
   * @param {string} walletAddress
   * @returns {Promise<Array<{questId: string, progress: number, target: number, claimed: boolean, streak: number}>>}
   */
  getQuestsForPlayer: async (walletAddress) => {
    const user = await UserModel.findByWallet(walletAddress);

    if (!user) {
      const definitions = await QuestModel.listDefinitions();
      return definitions.map((quest) => ({
        questId: quest.questId,
        progress: 0,
        target: quest.target,
        claimed: false,
        streak: 0,
      }));
    }

    const rows = await QuestModel.getProgressForUser(user.id);
    return rows.map((row) => ({
      questId: row.questId,
      progress: Number(row.progress),
      target: Number(row.target),
      claimed: Boolean(row.claimed),
      streak: Number(row.streak),
    }));
  },

  /**
   * Records the daily login quest for the authenticated user, resolved from
   * the JWT id on the request. Never accepts a wallet address from the
   * caller, so one player cannot check in on another player's behalf.
   *
   * @param {number|string} userId
   * @returns {Promise<object|null>}
   */
  checkInDaily: async (userId) => {
    const user = await UserModel.findById(userId);
    if (!user) {
      const error = new Error('Authenticated user was not found.');
      error.statusCode = 404;
      error.code = 'USER_NOT_FOUND';
      throw error;
    }

    return QuestModel.recordDailyLogin(user.id);
  },
};

module.exports = questService;
