#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct NestedWriteVault;

#[contractimpl]
impl NestedWriteVault {
    // FALSE NEGATIVE in the old linter: the storage write is two helper calls
    // away and never authorizes `caller`. The old inline-only matcher saw no
    // `.set(` in this body and passed it.
    pub fn drain(env: Env, caller: Address) {
        middle_helper(&env, &caller);
    }

    // An unclassified Address parameter must be reported rather than guessed.
    // `mystery` is neither a known actor name nor annotated, so the author has
    // to state its role explicitly.
    pub fn adjust(env: Env, mystery: Address) {
        env.storage().instance().set(&DataKey::X, &1i128);
    }
}

fn middle_helper(env: Env, caller: Address) {
    inner_write(&env, &caller);
}

fn inner_write(env: Env, caller: Address) {
    env.storage().instance().set(&caller, &0i128);
}
