use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RewardStatus {
    Pending = 0,
    Claimed = 1,
    Cancelled = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardConfig {
    pub admin: Address,
    pub treasury: Address,
    pub token: Address,
    pub is_paused: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OptionalRewardConfig {
    None,
    Some(RewardConfig),
}

impl OptionalRewardConfig {
    pub fn is_some(&self) -> bool {
        matches!(self, Self::Some(_))
    }

    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    pub fn unwrap(self) -> RewardConfig {
        match self {
            Self::Some(config) => config,
            Self::None => panic!("called unwrap on None"),
        }
    }
}

impl From<Option<RewardConfig>> for OptionalRewardConfig {
    fn from(opt: Option<RewardConfig>) -> Self {
        match opt {
            Some(config) => Self::Some(config),
            None => Self::None,
        }
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardState {
    pub user: Address,
    pub total_accrued: i128,
    pub total_claimed: i128,
    pub pending_balance: i128,
    pub last_update_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OptionalUserRewardState {
    None,
    Some(UserRewardState),
}

impl OptionalUserRewardState {
    pub fn is_some(&self) -> bool {
        matches!(self, Self::Some(_))
    }

    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    pub fn unwrap(self) -> UserRewardState {
        match self {
            Self::Some(state) => state,
            Self::None => panic!("called unwrap on None"),
        }
    }
}

impl From<Option<UserRewardState>> for OptionalUserRewardState {
    fn from(opt: Option<UserRewardState>) -> Self {
        match opt {
            Some(state) => Self::Some(state),
            None => Self::None,
        }
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardSnapshot {
    pub config: OptionalRewardConfig,
    pub user_state: OptionalUserRewardState,
    pub timestamp: u64,
    pub ledger: u32,
}
