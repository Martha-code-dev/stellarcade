#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct RoleAwareVault;

#[contractimpl]
impl RoleAwareVault {
    // FALSE POSITIVE in the old linter: `to` is a beneficiary receiving value.
    // It cannot be expected to sign a transaction it did not initiate, so only
    // the actor `from` must authorize.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        env.storage().instance().set(&to, &amount);
    }

    // FALSE POSITIVE: authorization and the storage write are both delegated
    // to same-file helpers. The actor is authorized through `authorize`.
    pub fn withdraw_via_helper(env: Env, caller: Address) {
        authorize(&env, &caller);
        write_balance(&env, &caller, 0i128);
    }

    // FALSE POSITIVE: state mutation with no Address argument at all, so there
    // is no caller identity for the rule to reason about.
    pub fn bump_counter(env: Env) {
        env.storage().instance().set(&DataKey::Counter, &1i128);
    }

    // FALSE POSITIVE: read-only accessor with an Address parameter. No storage
    // mutation means no auth requirement.
    pub fn balance_of(env: Env, who: Address) -> i128 {
        env.storage().instance().get(&who).unwrap_or(0)
    }

    // An unknown role is explicitly annotated as a beneficiary at the source,
    // so the linter can accept it without guessing.
    // auth-linter: beneficiary payee
    pub fn credit(env: Env, payee: Address, amount: i128) {
        env.storage().persistent().set(&payee, &amount);
    }
}

fn authorize(env: Env, who: Address) {
    who.require_auth();
}

fn write_balance(env: Env, who: Address, amount: i128) {
    env.storage().instance().set(&who, &amount);
}
