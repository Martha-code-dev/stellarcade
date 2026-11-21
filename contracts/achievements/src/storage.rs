use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::types::*;

// Storage keys

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Achievements(Address), // per user achievements
    NextUnlock(Address),
    ClaimGracePeriod(Address),
}

const PERSISTENT_BUMP_THRESHOLD: u32 = 100_800; // ~7 days
const PERSISTENT_BUMP_LEDGERS: u32 = 518_400; // ~30 days

// Storage functions

pub fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_achievements(env: &Env, user: &Address) -> Vec<Achievement> {
    env.storage()
        .persistent()
        .get(&DataKey::Achievements(user.clone()))
        .unwrap_or(Vec::new(env))
}

pub fn set_achievements(env: &Env, user: &Address, achievements: &Vec<Achievement>) {
    let key = DataKey::Achievements(user.clone());
    env.storage().persistent().set(&key, achievements);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_LEDGERS);
}

pub fn get_next_unlock(env: &Env, user: &Address) -> Option<NextUnlock> {
    env.storage()
        .persistent()
        .get(&DataKey::NextUnlock(user.clone()))
}

pub fn set_next_unlock(env: &Env, user: &Address, unlock: &NextUnlock) {
    let key = DataKey::NextUnlock(user.clone());
    env.storage().persistent().set(&key, unlock);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_LEDGERS);
}

pub fn get_claim_grace_period(env: &Env, user: &Address) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::ClaimGracePeriod(user.clone()))
}

pub fn set_claim_grace_period(env: &Env, user: &Address, grace_ledger: u32) {
    let key = DataKey::ClaimGracePeriod(user.clone());
    env.storage().persistent().set(&key, &grace_ledger);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_LEDGERS);
}
