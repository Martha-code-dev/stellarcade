#![cfg(test)]
use soroban_sdk::{testutils::Address as _, Address, Env};

use super::*;

fn setup_bracket(env: &Env) -> (ChallengeLadderClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(ChallengeLadder, ());
    let client = ChallengeLadderClient::new(env, &contract_id);
    env.mock_all_auths();
    client.init(&admin);
    (client, admin)
}

#[test]
fn test_bracket_health_summary_empty() {
    let env = Env::default();
    let contract_id = env.register(ChallengeLadder, ());
    let client = ChallengeLadderClient::new(&env, &contract_id);

    let summary = client.bracket_health_summary(&1);
    assert_eq!(summary.bracket_id, 1);
    assert!(!summary.exists);
    assert_eq!(summary.player_count, 0);
    assert_eq!(summary.active_games, 0);
    assert_eq!(summary.promotion_threshold, 0);
}

#[test]
fn test_promotion_cutoff_empty() {
    let env = Env::default();
    let contract_id = env.register(ChallengeLadder, ());
    let client = ChallengeLadderClient::new(&env, &contract_id);

    let cutoff = client.promotion_cutoff(&1);
    assert_eq!(cutoff.bracket_id, 1);
    assert!(!cutoff.exists);
    assert_eq!(cutoff.cutoff_score, 0);
    assert_eq!(cutoff.cutoff_rank, 0);
    assert_eq!(cutoff.next_promotion_time, 0);
}

#[test]
fn test_ladder_ranking_snapshot_empty() {
    let env = Env::default();
    let (client, _admin) = setup_bracket(&env);
    let snapshot = client.ladder_ranking_snapshot(&5);
    assert_eq!(snapshot.bracket_id, 5);
    assert!(!snapshot.exists);
    assert_eq!(snapshot.player_count, 0);
    assert_eq!(snapshot.active_games, 0);
    assert_eq!(snapshot.cutoff_score, 0);
    assert_eq!(snapshot.cutoff_rank, 0);
    assert_eq!(snapshot.next_promotion_time, 0);
}

#[test]
fn test_tier_cutoff_empty() {
    let env = Env::default();
    let (client, _admin) = setup_bracket(&env);
    let tc = client.tier_cutoff(&3);
    assert_eq!(tc.bracket_id, 3);
    assert!(!tc.exists);
    assert_eq!(tc.cutoff_score, 0);
    assert_eq!(tc.cutoff_rank, 0);
    assert_eq!(tc.promotion_threshold, 0);
    assert!(!tc.has_capacity);
}

#[test]
fn test_bracket_domain_behavior_with_data() {
    let env = Env::default();
    let (client, admin) = setup_bracket(&env);

    let bracket_data = BracketData {
        player_count: 50,
        active_games: 10,
        promotion_threshold: 1000,
        cutoff_score: 950,
        cutoff_rank: 100,
        next_promotion_time: 123456,
    };
    let health_data = BracketHealthData {
        player_count: 50,
        active_games: 10,
        promotion_threshold: 1000,
    };

    client.set_bracket(&admin, &1, &bracket_data);
    client.set_bracket_health(&admin, &1, &health_data);

    let summary = client.bracket_health_summary(&1);
    assert!(summary.exists);
    assert_eq!(summary.player_count, 50);
    assert_eq!(summary.active_games, 10);
    assert_eq!(summary.promotion_threshold, 1000);

    let snapshot = client.ladder_ranking_snapshot(&1);
    assert!(snapshot.exists);
    assert_eq!(snapshot.cutoff_score, 950);
    assert_eq!(snapshot.cutoff_rank, 100);
    assert_eq!(snapshot.next_promotion_time, 123456);

    let tier = client.tier_cutoff(&1);
    assert!(tier.exists);
    assert!(tier.has_capacity); // 50 < 100
}

#[test]
fn test_unauthorized_setter_rejected() {
    let env = Env::default();
    let (client, _admin) = setup_bracket(&env);
    let attacker = Address::generate(&env);

    let bracket_data = BracketData {
        player_count: 50,
        active_games: 10,
        promotion_threshold: 1000,
        cutoff_score: 950,
        cutoff_rank: 100,
        next_promotion_time: 123456,
    };

    let result = client.try_set_bracket(&attacker, &1, &bracket_data);
    assert!(result.is_err());
}
