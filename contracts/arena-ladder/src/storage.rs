use soroban_sdk::{Env, Vec};

use crate::{types::BracketRecord, DataKey};

pub const PERSISTENT_BUMP_LEDGERS: u32 = 518_400;

/// IDs of brackets that have been written, kept in instance storage so the
/// cross-bracket summary never has to probe absent persistent keys (#1591).
pub fn get_bracket_ids(env: &Env) -> Vec<u32> {
    env.storage()
        .instance()
        .get(&DataKey::BracketIds)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn add_bracket_id(env: &Env, bracket_id: u32) {
    let mut ids = get_bracket_ids(env);
    if !ids.contains(bracket_id) {
        ids.push_back(bracket_id);
        env.storage().instance().set(&DataKey::BracketIds, &ids);
    }
}

pub fn get_bracket(env: &Env, bracket_id: u32) -> Option<BracketRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::Bracket(bracket_id))
}

pub fn set_bracket(env: &Env, bracket_id: u32, record: &BracketRecord) {
    env.storage()
        .persistent()
        .set(&DataKey::Bracket(bracket_id), record);
    env.storage().persistent().extend_ttl(
        &DataKey::Bracket(bracket_id),
        PERSISTENT_BUMP_LEDGERS,
        PERSISTENT_BUMP_LEDGERS,
    );
}

pub fn get_season_cutoff(env: &Env, season_id: u32) -> Option<u32> {
    env.storage()
        .instance()
        .get(&DataKey::SeasonCutoff(season_id))
}

pub fn set_season_cutoff(env: &Env, season_id: u32, cutoff_ledger: u32) {
    env.storage()
        .instance()
        .set(&DataKey::SeasonCutoff(season_id), &cutoff_ledger);
}
