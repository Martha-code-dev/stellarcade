/**
 * Controller for managing quest-related API requests.
 */
const questService = require('../services/quest.service');

const getQuests = async (req, res, next) => {
  try {
    const player = req.query.player;
    if (!player || typeof player !== 'string') {
      const error = new Error('Query parameter "player" is required.');
      error.statusCode = 400;
      error.code = 'INVALID_QUERY_PARAM';
      throw error;
    }

    const quests = await questService.getQuestsForPlayer(player);
    res.status(200).json(quests);
  } catch (error) {
    next(error);
  }
};

const postDailyCheckIn = async (req, res, next) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      const error = new Error('Authenticated user is required.');
      error.statusCode = 401;
      error.code = 'UNAUTHORIZED';
      throw error;
    }

    const quest = await questService.checkInDaily(userId);
    res.status(200).json({ quest });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getQuests,
  postDailyCheckIn,
};
