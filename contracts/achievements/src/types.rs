use soroban_sdk::{contracttype, Address, String};

// Types for achievements contract

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Achievement {
    pub id: u32,
    pub category: String,
    pub title: String,
    pub unlocked: bool,
}

/// Optional `Achievement` wrapper for use inside `#[contracttype]` structs.
/// Soroban's XDR layer does not support `Option<CustomStruct>` as a field.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OptionalAchievement {
    None,
    Some(Achievement),
}

impl From<Option<Achievement>> for OptionalAchievement {
    fn from(value: Option<Achievement>) -> Self {
        match value {
            Some(achievement) => OptionalAchievement::Some(achievement),
            None => OptionalAchievement::None,
        }
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CategoryCompletionSummary {
    pub category: String,
    pub total_achievements: u32,
    pub unlocked_achievements: u32,
    pub completion_percentage: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NextUnlock {
    pub user: Address,
    pub next_achievement: OptionalAchievement,
    pub progress: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AchievementUnlockSnapshot {
    pub user: Address,
    pub total_achievements: u32,
    pub unlocked_achievements: u32,
    pub locked_achievements: u32,
    pub completion_percentage: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimGraceAccessor {
    pub user: Address,
    pub grace_period_ledger: u32,
    pub current_ledger: u32,
    pub is_within_grace_period: bool,
    pub ledgers_remaining: u32,
}
