#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, BytesN as _},
    Address, Env,
};

fn random_hash(env: &Env) -> BytesN<32> {
    BytesN::random(env)
}

fn setup(env: &Env) -> (ComprehensiveTestSuiteClient<'_>, Address, Address) {
    let admin = Address::generate(env);
    let reporter = Address::generate(env);
    let contract_id = env.register(ComprehensiveTestSuite, ());
    let client = ComprehensiveTestSuiteClient::new(env, &contract_id);

    env.mock_all_auths();
    client.init(&admin, &reporter, &8_000u32);

    (client, admin, reporter)
}

#[test]
fn register_and_record_successful_run_enables_release_gate() {
    let env = Env::default();
    let (client, admin, reporter) = setup(&env);
    let suite = Symbol::new(&env, "core_suite");

    env.mock_all_auths();
    client.register_suite(&admin, &suite, &10u32, &true, &false);

    let gate_ok = client.record_run(
        &reporter,
        &suite,
        &random_hash(&env),
        &10u32,
        &0u32,
        &8_500u32,
        &true,
        &false,
    );

    assert!(gate_ok);
    assert!(client.is_release_ready(&suite));

    let state = client.state();
    assert_eq!(state.total_suites, 1);
    assert_eq!(state.total_runs, 1);
}

#[test]
fn unauthorized_reporter_is_rejected() {
    let env = Env::default();
    let (client, admin, _) = setup(&env);
    let suite = Symbol::new(&env, "core_suite");
    let attacker = Address::generate(&env);

    env.mock_all_auths();
    client.register_suite(&admin, &suite, &1u32, &false, &false);

    let result = client.try_record_run(
        &attacker,
        &suite,
        &random_hash(&env),
        &1u32,
        &0u32,
        &9_000u32,
        &false,
        &false,
    );

    assert!(result.is_err());
}

#[test]
fn unauthorized_admin_cannot_pause_or_mutate() {
    let env = Env::default();
    let (client, _admin, _) = setup(&env);
    let attacker = Address::generate(&env);

    env.mock_all_auths();
    let pause_res = client.try_pause(&attacker);
    assert!(pause_res.is_err());

    let reporter_res = client.try_set_reporter(&attacker, &attacker);
    assert!(reporter_res.is_err());

    let suite = Symbol::new(&env, "auth_suite");
    let register_res = client.try_register_suite(&attacker, &suite, &1u32, &false, &false);
    assert!(register_res.is_err());
}

#[test]
fn duplicate_run_is_rejected() {
    let env = Env::default();
    let (client, admin, reporter) = setup(&env);
    let suite = Symbol::new(&env, "dup_suite");
    let build = random_hash(&env);

    env.mock_all_auths();
    client.register_suite(&admin, &suite, &1u32, &false, &false);

    assert!(client.record_run(&reporter, &suite, &build, &1u32, &0u32, &8_000u32, &false, &false,));

    let dup = client.try_record_run(
        &reporter, &suite, &build, &1u32, &0u32, &8_000u32, &false, &false,
    );

    assert!(dup.is_err());
}

#[test]
fn required_integration_signal_is_enforced() {
    let env = Env::default();
    let (client, admin, reporter) = setup(&env);
    let suite = Symbol::new(&env, "int_suite");

    env.mock_all_auths();
    client.register_suite(&admin, &suite, &5u32, &true, &false);

    let gate_ok = client.record_run(
        &reporter,
        &suite,
        &random_hash(&env),
        &5u32,
        &0u32,
        &9_000u32,
        &false,
        &false,
    );

    assert!(!gate_ok);
    assert!(!client.is_release_ready(&suite));
}

#[test]
fn pause_and_unpause_flow() {
    let env = Env::default();
    let (client, admin, reporter) = setup(&env);
    let suite = Symbol::new(&env, "pause_flow");

    env.mock_all_auths();
    client.register_suite(&admin, &suite, &1u32, &false, &false);

    client.pause(&admin);
    let state = client.state();
    assert!(state.paused);

    let blocked = client.try_record_run(
        &reporter,
        &suite,
        &random_hash(&env),
        &1u32,
        &0u32,
        &9_000u32,
        &false,
        &false,
    );
    assert!(blocked.is_err());

    client.unpause(&admin);
    let state_unpaused = client.state();
    assert!(!state_unpaused.paused);
}

#[test]
fn kill_switch_blocks_future_mutations() {
    let env = Env::default();
    let (client, admin, _) = setup(&env);

    env.mock_all_auths();
    client.trigger_kill_switch(&admin, &random_hash(&env));

    let res =
        client.try_register_suite(&admin, &Symbol::new(&env, "blocked"), &1u32, &false, &false);
    assert!(res.is_err());

    let state = client.state();
    assert!(state.killed);
}
