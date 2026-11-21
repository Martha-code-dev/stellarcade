/**
 * Unit tests for quest completion vs reward settlement at the service
 * boundary (#1588).
 *
 * Completion is progress >= target; settlement is the `claimed` flag, which
 * drives XP/payout display in the web UI. A completed quest must never be
 * presented as an already-settled payout.
 */
jest.mock('../../src/config/database', () => ({}));
jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), info: jest.fn() }));

const UserModel = require('../../src/models/User.model');
const QuestModel = require('../../src/models/Quest.model');
const questService = require('../../src/services/quest.service');

jest.mock('../../src/models/User.model');
jest.mock('../../src/models/Quest.model');

describe('questService.getQuestsForPlayer settlement semantics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a completed but unsettled quest keeps claimed false at the API boundary', async () => {
    UserModel.findByWallet.mockResolvedValue({ id: 7, wallet_address: 'GALICE' });
    QuestModel.getProgressForUser.mockResolvedValue([
      { questId: 'play-5-games', target: 5, progress: 5, claimed: false, streak: 1 },
    ]);

    const quests = await questService.getQuestsForPlayer('GALICE');

    expect(quests).toEqual([
      { questId: 'play-5-games', progress: 5, target: 5, claimed: false, streak: 1 },
    ]);
    // Completion is visible via progress >= target while `claimed`, the flag
    // the UI sums XP from, stays false. No payout is implied.
    expect(quests[0].progress >= quests[0].target).toBe(true);
    expect(quests[0].claimed).toBe(false);
  });

  test('a genuinely settled quest still returns claimed true', async () => {
    UserModel.findByWallet.mockResolvedValue({ id: 7, wallet_address: 'GALICE' });
    QuestModel.getProgressForUser.mockResolvedValue([
      { questId: 'daily-login', target: 1, progress: 1, claimed: true, streak: 4 },
    ]);

    const quests = await questService.getQuestsForPlayer('GALICE');

    expect(quests[0]).toEqual({
      questId: 'daily-login',
      progress: 1,
      target: 1,
      claimed: true,
      streak: 4,
    });
  });

  test('an accountless player sees no implied settlement', async () => {
    UserModel.findByWallet.mockResolvedValue(null);
    QuestModel.listDefinitions.mockResolvedValue([
      { id: 1, questId: 'daily-login', title: 'Log in today', target: 1 },
      { id: 2, questId: 'play-5-games', title: 'Play 5 games', target: 5 },
    ]);

    const quests = await questService.getQuestsForPlayer('GUNKNOWN');

    expect(quests.every((q) => q.claimed === false)).toBe(true);
    expect(QuestModel.getProgressForUser).not.toHaveBeenCalled();
  });
});
