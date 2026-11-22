#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contracterror, contractimpl, testutils::Address as _, Address, Env, String,
};

#[contract]
struct MockRegistry;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
enum MockRegistryError {
    NotInitialized = 2,
    ContractNotFound = 4,
}

#[contractimpl]
impl MockRegistry {
    pub fn resolve(env: Env, name: String) -> Result<Address, MockRegistryError> {
        let mode: u32 = env.storage().instance().get(&"mode").unwrap_or(0);
        if mode == 1 {
            return Err(MockRegistryError::NotInitialized);
        }
        let key = ("addr", name);
        env.storage()
            .instance()
            .get(&key)
            .ok_or(MockRegistryError::ContractNotFound)
    }
}

#[contract]
struct MockPrizePool;

#[contractimpl]
impl MockPrizePool {
    pub fn get_config_snapshot(env: Env) -> Result<PrizePoolConfigSnapshot, PrizePoolReadError> {
        let admin: Address = env.storage().instance().get(&"admin").unwrap();
        let token: Address = env.storage().instance().get(&"token").unwrap();
        Ok(PrizePoolConfigSnapshot {
            admin,
            token,
            available_balance: 10,
            reserved_amount: 2,
            payouts_count: 3,
            last_update_ledger: 4,
        })
    }
}

fn setup() -> (Env, ContractInteractionLibraryClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(ContractInteractionLibrary, ());
    let client = ContractInteractionLibraryClient::new(&env, &contract_id);
    client.init(&admin);
    (env, client, admin)
}

fn setup_registry_with_prize_pool(env: &Env) -> (Address, Address) {
    let registry_id = env.register(MockRegistry, ());
    let prize_pool_id = env.register(MockPrizePool, ());

    env.as_contract(&registry_id, || {
        env.storage().instance().set(
            &("addr", String::from_str(env, "prize-pool")),
            &prize_pool_id,
        );
    });

    let pool_admin = Address::generate(env);
    let token = Address::generate(env);
    env.as_contract(&prize_pool_id, || {
        env.storage().instance().set(&"admin", &pool_admin);
        env.storage().instance().set(&"token", &token);
    });

    (registry_id, prize_pool_id)
}

#[test]
fn test_init() {
    let _ = setup();
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_double_init_fails() {
    let (_, client, admin) = setup();
    client.init(&admin);
}

#[test]
fn test_register_and_resolve() {
    let (env, client, _admin) = setup();
    let target = Address::generate(&env);
    let name = String::from_str(&env, "token-contract");
    client.register_contract(&name, &target, &1);
    let resolved = client.resolve(&name);
    assert_eq!(resolved, target);
}

#[test]
#[should_panic(expected = "Contract name already registered")]
fn test_duplicate_name_rejected() {
    let (env, client, _admin) = setup();
    let addr = Address::generate(&env);
    let name = String::from_str(&env, "foo");
    client.register_contract(&name, &addr, &1);
    client.register_contract(&name, &addr, &2);
}

#[test]
#[should_panic(expected = "Contract is inactive")]
fn test_deactivate_blocks_resolve() {
    let (env, client, _admin) = setup();
    let addr = Address::generate(&env);
    let name = String::from_str(&env, "bar");
    client.register_contract(&name, &addr, &1);
    client.deactivate_contract(&name);
    client.resolve(&name);
}

#[test]
fn test_upgrade_reactivates() {
    let (env, client, _admin) = setup();
    let addr = Address::generate(&env);
    let addr2 = Address::generate(&env);
    let name = String::from_str(&env, "baz");
    client.register_contract(&name, &addr, &1);
    client.deactivate_contract(&name);
    client.upgrade_contract(&name, &addr2, &2);
    assert_eq!(client.resolve(&name), addr2);
}

#[test]
#[should_panic(expected = "Invalid name")]
fn test_empty_name_rejected() {
    let (env, client, _) = setup();
    let addr = Address::generate(&env);
    client.register_contract(&String::from_str(&env, ""), &addr, &1);
}

#[test]
#[should_panic(expected = "Invalid version")]
fn test_zero_version_rejected() {
    let (env, client, _) = setup();
    let addr = Address::generate(&env);
    client.register_contract(&String::from_str(&env, "valid"), &addr, &0);
}

#[test]
#[should_panic(expected = "Contract not found")]
fn test_unknown_contract_panics() {
    let (env, client, _) = setup();
    client.get_contract(&String::from_str(&env, "ghost"));
}

#[test]
fn test_call_log_roundtrip() {
    let (env, client, _) = setup();
    let caller = Address::generate(&env);
    let callee = String::from_str(&env, "staking");
    let id = client.log_call(&callee, &caller, &true);
    let record = client.get_call_log(&id);
    assert!(record.success);
    assert_eq!(record.callee_name, callee);
}

#[test]
fn test_call_log_increments() {
    let (env, client, _) = setup();
    let caller = Address::generate(&env);
    let callee = String::from_str(&env, "game");
    let id0 = client.log_call(&callee, &caller, &true);
    let id1 = client.log_call(&callee, &caller, &false);
    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
}

#[test]
fn test_get_contract_returns_full_entry() {
    let (env, client, _) = setup();
    let addr = Address::generate(&env);
    let name = String::from_str(&env, "my-contract");
    client.register_contract(&name, &addr, &3);
    let entry = client.get_contract(&name);
    assert_eq!(entry.version, 3);
    assert!(entry.active);
}

#[test]
fn typed_read_resolves_and_reads_prize_pool() {
    let (env, client, _) = setup();
    let (registry_id, _pool_id) = setup_registry_with_prize_pool(&env);

    let snap = client.read_prize_pool_config(&registry_id);
    assert_eq!(snap.available_balance, 10);
    assert_eq!(snap.reserved_amount, 2);
}

#[test]
fn typed_read_missing_registry_entry_normalizes_error() {
    let (env, client, _) = setup();
    let registry_id = env.register(MockRegistry, ());
    let err = client
        .try_read_prize_pool_config(&registry_id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, CoreReadError::RegistryEntryMissing);
}

#[test]
fn typed_read_registry_not_initialized_normalizes_error() {
    let (env, client, _) = setup();
    let registry_id = env.register(MockRegistry, ());
    env.as_contract(&registry_id, || {
        env.storage().instance().set(&"mode", &1u32);
    });

    let err = client
        .try_read_prize_pool_config(&registry_id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, CoreReadError::RegistryNotInitialized);
}
