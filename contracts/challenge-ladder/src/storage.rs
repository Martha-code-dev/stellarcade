use soroban_sdk::{Address, Env};

use crate::{BracketData, BracketHealthData, DataKey};

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

pub fn get_bracket_data(env: &Env, bracket_id: u32) -> Option<BracketData> {
    env.storage().instance().get(&DataKey::Bracket(bracket_id))
}

pub fn set_bracket_data(env: &Env, bracket_id: u32, data: &BracketData) {
    env.storage()
        .instance()
        .set(&DataKey::Bracket(bracket_id), data);
}

pub fn get_bracket_health_data(env: &Env, bracket_id: u32) -> Option<BracketHealthData> {
    env.storage()
        .instance()
        .get(&DataKey::BracketHealth(bracket_id))
}

pub fn set_bracket_health_data(env: &Env, bracket_id: u32, health: &BracketHealthData) {
    env.storage()
        .instance()
        .set(&DataKey::BracketHealth(bracket_id), health);
}
