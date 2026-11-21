use soroban_sdk::{contracttype, Address, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchStatus {
    Pending = 0,
    Active = 1,
    Completed = 2,
    Cancelled = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Squad {
    pub id: u32,
    pub members: Vec<Address>,
    pub total_score: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchConfig {
    pub admin: Address,
    pub min_players_per_squad: u32,
    pub max_squads: u32,
    pub is_paused: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchState {
    pub match_id: u32,
    pub squads: Vec<Squad>,
    pub status: MatchStatus,
    pub start_time: u64,
}

/// Optional `MatchConfig` wrapper for use inside `#[contracttype]` structs.
/// Soroban's XDR layer does not support `Option<CustomStruct>` as a field, so
/// an explicit two-variant enum is used instead.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum OptionalMatchConfig {
    None,
    Some(MatchConfig),
}

impl From<Option<MatchConfig>> for OptionalMatchConfig {
    fn from(value: Option<MatchConfig>) -> Self {
        match value {
            Some(config) => OptionalMatchConfig::Some(config),
            None => OptionalMatchConfig::None,
        }
    }
}

/// Optional `MatchState` wrapper for use inside `#[contracttype]` structs.
/// Soroban's XDR layer does not support `Option<CustomStruct>` as a field, so
/// an explicit two-variant enum is used instead.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum OptionalMatchState {
    None,
    Some(MatchState),
}

impl From<Option<MatchState>> for OptionalMatchState {
    fn from(value: Option<MatchState>) -> Self {
        match value {
            Some(state) => OptionalMatchState::Some(state),
            None => OptionalMatchState::None,
        }
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchSnapshot {
    pub config: OptionalMatchConfig,
    pub match_state: OptionalMatchState,
    pub timestamp: u64,
}
