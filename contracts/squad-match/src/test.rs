use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

struct Setup {
    env: Env,
    client: SquadMatchClient<'static>,
    admin: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(SquadMatch, ());
    let client = SquadMatchClient::new(&env, &contract_id);

    let admin = Address::generate(&env);

    let client: SquadMatchClient<'static> = unsafe { core::mem::transmute(client) };

    Setup { env, client, admin }
}

#[test]
fn test_init_and_snapshot() {
    let s = setup();
    s.client.init(&s.admin, &2, &4);

    let snapshot = s.client.get_match_snapshot(&1);
    assert_eq!(
        snapshot.config,
        OptionalMatchConfig::Some(MatchConfig {
            admin: s.admin.clone(),
            min_players_per_squad: 2,
            max_squads: 4,
            is_paused: false,
        })
    );
    assert_eq!(snapshot.match_state, OptionalMatchState::None);
    assert!(!s.client.is_paused());
}

#[test]
fn test_create_match_and_query() {
    let s = setup();
    s.client.init(&s.admin, &2, &4);

    let user = Address::generate(&s.env);
    s.client.create_match(&101, &user);

    assert_eq!(s.client.get_match_status(&101), MatchStatus::Pending);

    let snapshot = s.client.get_match_snapshot(&101);
    assert!(matches!(snapshot.match_state, OptionalMatchState::Some(_)));
}

#[test]
fn test_paused_system() {
    let s = setup();
    s.client.init(&s.admin, &2, &4);

    s.client.set_pause(&true);
    assert!(s.client.is_paused());

    let user = Address::generate(&s.env);
    let result = s.client.try_create_match(&102, &user);
    assert_eq!(result, Err(Ok(Error::Paused)));
}

#[test]
fn test_missing_match_fallback() {
    let s = setup();
    s.client.init(&s.admin, &2, &4);

    assert_eq!(s.client.get_match_status(&999), MatchStatus::Cancelled);
}

#[test]
fn test_uninitialized_reads() {
    let env = Env::default();
    let contract_id = env.register(SquadMatch, ());
    let client = SquadMatchClient::new(&env, &contract_id);

    let snapshot = client.get_match_snapshot(&1);
    assert_eq!(snapshot.config, OptionalMatchConfig::None);
    assert_eq!(snapshot.match_state, OptionalMatchState::None);
    assert!(client.is_paused());
}

#[test]
fn test_authorization_and_invariants() {
    let s = setup();
    s.client.init(&s.admin, &2, &4);

    // Double initialization is rejected
    let res = s.client.try_init(&s.admin, &2, &4);
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized)));

    // Pause toggles correctly
    s.client.set_pause(&true);
    assert!(s.client.is_paused());
    s.client.set_pause(&false);
    assert!(!s.client.is_paused());
}
