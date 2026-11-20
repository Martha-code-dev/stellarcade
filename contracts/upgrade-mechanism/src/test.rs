use super::*;
use soroban_sdk::{
    testutils::{Address as _, BytesN as _},
    Address, Env,
};

#[contract]
struct MockGate;

#[contracttype]
#[derive(Clone)]
enum GateDataKey {
    Ready,
}

#[contractimpl]
impl MockGate {
    pub fn set_ready(env: Env, ready: bool) {
        env.storage().instance().set(&GateDataKey::Ready, &ready);
    }

    pub fn is_release_ready(env: Env, _suite: Symbol) -> bool {
        env.storage()
            .instance()
            .get(&GateDataKey::Ready)
            .unwrap_or(false)
    }
}

fn random_hash(env: &Env) -> BytesN<32> {
    BytesN::random(env)
}

fn setup(env: &Env) -> (UpgradeMechanismClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(UpgradeMechanism, ());
    let client = UpgradeMechanismClient::new(env, &contract_id);

    env.mock_all_auths();
    client.init(&admin, &random_hash(env), &1u32);

    (client, admin)
}

#[test]
fn init_and_state_are_consistent() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let state = client.state();
    assert_eq!(state.admin, admin);
    assert_eq!(state.current_version, 1);
    assert_eq!(state.current_schema_version, 1);
    assert!(!state.paused);
    assert!(!state.killed);
}

#[test]
fn unauthorized_stage_is_rejected() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let attacker = Address::generate(&env);

    env.mock_all_auths();
    let result = client.try_stage_upgrade(
        &attacker,
        &2u32,
        &random_hash(&env),
        &2u32,
        &random_hash(&env),
        &random_hash(&env),
    );
    assert!(result.is_err());
}

#[test]
fn stage_execute_and_get_release_work() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    env.mock_all_auths();

    client.stage_upgrade(
        &admin,
        &2u32,
        &random_hash(&env),
        &2u32,
        &random_hash(&env),
        &random_hash(&env),
    );
    client.execute_upgrade(&admin);

    let state = client.state();
    assert_eq!(state.current_version, 2);
    assert_eq!(state.current_schema_version, 2);
    assert!(client.get_release(&2u32).is_some());
}

#[test]
fn duplicate_version_is_rejected() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    env.mock_all_auths();

    client.stage_upgrade(
        &admin,
        &2u32,
        &random_hash(&env),
        &1u32,
        &random_hash(&env),
        &random_hash(&env),
    );
    client.execute_upgrade(&admin);

    let result = client.try_stage_upgrade(
        &admin,
        &2u32,
        &random_hash(&env),
        &1u32,
        &random_hash(&env),
        &random_hash(&env),
    );
    assert!(result.is_err());
}

#[test]
fn pause_blocks_mutations() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    env.mock_all_auths();

    client.pause(&admin);
    let result = client.try_stage_upgrade(
        &admin,
        &2u32,
        &random_hash(&env),
        &1u32,
        &random_hash(&env),
        &random_hash(&env),
    );
    assert!(result.is_err());
}

#[test]
fn rollback_restores_previous_release() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    env.mock_all_auths();

    client.stage_upgrade(
        &admin,
        &2u32,
        &random_hash(&env),
        &2u32,
        &random_hash(&env),
        &random_hash(&env),
    );
    client.execute_upgrade(&admin);

    client.rollback(&admin, &random_hash(&env));

    let state = client.state();
    assert_eq!(state.current_version, 1);
    assert_eq!(state.current_schema_version, 1);
}

#[test]
fn test_gate_can_block_execute() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let gate_id = env.register(MockGate, ());
    let gate_client = MockGateClient::new(&env, &gate_id);

    env.mock_all_auths();
    gate_client.set_ready(&false);
    client.configure_test_gate(&admin, &gate_id, &Symbol::new(&env, "core_suite"), &true);

    client.stage_upgrade(
        &admin,
        &2u32,
        &random_hash(&env),
        &1u32,
        &random_hash(&env),
        &random_hash(&env),
    );

    let blocked = client.try_execute_upgrade(&admin);
    assert!(blocked.is_err());

    gate_client.set_ready(&true);
    client.execute_upgrade(&admin);

    let state = client.state();
    assert_eq!(state.current_version, 2);
}

#[test]
fn kill_switch_freezes_contract() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    env.mock_all_auths();

    client.trigger_kill_switch(&admin, &random_hash(&env));
    let res = client.try_unpause(&admin);
    assert!(res.is_err());

    let state = client.state();
    assert!(state.killed);
    assert!(state.paused);
}
