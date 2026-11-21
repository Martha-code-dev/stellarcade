use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env, String};

fn setup(env: &Env) -> (AchievementsContractClient<'_>, Address) {
    env.mock_all_auths();
    let contract_id = env.register(AchievementsContract, ());
    let client = AchievementsContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    client.initialize(&admin);
    (client, admin)
}

fn achievement(env: &Env, id: u32, category: &str, unlocked: bool) -> Achievement {
    Achievement {
        id,
        category: String::from_str(env, category),
        title: String::from_str(env, "Achievement"),
        unlocked,
    }
}

#[test]
fn test_get_category_completion_summary() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let user = Address::generate(&env);
    client.add_achievement(&user, &achievement(&env, 1, "combat", true));
    client.add_achievement(&user, &achievement(&env, 2, "combat", false));

    let summary = client.get_category_completion_summary(&user, &String::from_str(&env, "combat"));
    assert_eq!(summary.total_achievements, 2);
    assert_eq!(summary.unlocked_achievements, 1);
    assert_eq!(summary.completion_percentage, 50);
}

#[test]
fn test_get_next_unlock_round_trip() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let user = Address::generate(&env);
    assert!(client.get_next_unlock(&user).is_none());

    let first = achievement(&env, 1, "combat", false);
    let unlock = NextUnlock {
        user: user.clone(),
        next_achievement: OptionalAchievement::Some(first.clone()),
        progress: 25,
    };
    client.set_next_unlock(&user, &unlock);

    let stored = client.get_next_unlock(&user).unwrap();
    assert_eq!(stored.user, user);
    assert_eq!(stored.progress, 25);
    assert_eq!(stored.next_achievement, OptionalAchievement::Some(first));

    client.set_next_unlock(
        &user,
        &NextUnlock {
            user: user.clone(),
            next_achievement: OptionalAchievement::None,
            progress: 0,
        },
    );
    let cleared = client.get_next_unlock(&user).unwrap();
    assert_eq!(cleared.next_achievement, OptionalAchievement::None);
}

#[test]
fn test_get_achievement_unlock_snapshot() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let user = Address::generate(&env);
    client.add_achievement(&user, &achievement(&env, 1, "combat", true));
    client.add_achievement(&user, &achievement(&env, 2, "combat", false));
    client.add_achievement(&user, &achievement(&env, 3, "exploration", true));

    let snapshot = client.get_achievement_unlock_snapshot(&user);
    assert_eq!(snapshot.total_achievements, 3);
    assert_eq!(snapshot.unlocked_achievements, 2);
    assert_eq!(snapshot.locked_achievements, 1);
    assert_eq!(snapshot.completion_percentage, 66);
}

#[test]
fn test_get_achievement_unlock_snapshot_empty() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let user = Address::generate(&env);
    let snapshot = client.get_achievement_unlock_snapshot(&user);
    assert_eq!(snapshot.total_achievements, 0);
    assert_eq!(snapshot.unlocked_achievements, 0);
    assert_eq!(snapshot.locked_achievements, 0);
    assert_eq!(snapshot.completion_percentage, 0);
}

#[test]
fn test_get_claim_grace_accessor() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let user = Address::generate(&env);
    let current_ledger = env.ledger().sequence();
    let grace_ledger = current_ledger + 100;
    client.set_claim_grace_period(&user, &grace_ledger);

    let accessor = client.get_claim_grace_accessor(&user);
    assert_eq!(accessor.grace_period_ledger, grace_ledger);
    assert!(accessor.is_within_grace_period);
    assert!(accessor.ledgers_remaining > 0);
}

#[test]
fn test_get_claim_grace_accessor_expired() {
    let env = Env::default();
    let (client, _admin) = setup(&env);
    env.ledger().with_mut(|ledger| ledger.sequence_number = 100);

    let user = Address::generate(&env);
    let current_ledger = env.ledger().sequence();
    let grace_ledger = current_ledger - 10;
    client.set_claim_grace_period(&user, &grace_ledger);

    let accessor = client.get_claim_grace_accessor(&user);
    assert!(!accessor.is_within_grace_period);
    assert_eq!(accessor.ledgers_remaining, 0);
}

#[test]
fn test_get_claim_grace_accessor_not_set() {
    let env = Env::default();
    let (client, _admin) = setup(&env);

    let user = Address::generate(&env);
    let accessor = client.get_claim_grace_accessor(&user);
    assert_eq!(accessor.grace_period_ledger, 0);
    assert!(!accessor.is_within_grace_period);
    assert_eq!(accessor.ledgers_remaining, 0);
}

#[test]
fn test_persistent_writes_extend_ttl() {
    use soroban_sdk::testutils::storage::Persistent as _;

    let env = Env::default();
    let contract_id = env.register(AchievementsContract, ());
    let client = AchievementsContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);
    client.add_achievement(&user, &achievement(&env, 1, "combat", true));
    client.set_claim_grace_period(&user, &env.ledger().sequence());

    let achievements_key = super::storage::DataKey::Achievements(user.clone());
    let grace_key = super::storage::DataKey::ClaimGracePeriod(user.clone());
    env.as_contract(&contract_id, || {
        assert_eq!(
            env.storage().persistent().get_ttl(&achievements_key),
            518_400
        );
        assert_eq!(env.storage().persistent().get_ttl(&grace_key), 518_400);
    });
}

#[test]
fn test_write_functions_require_admin_authorization() {
    let env = Env::default();
    let contract_id = env.register(AchievementsContract, ());
    let client = AchievementsContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let user = Address::generate(&env);
    let ach = achievement(&env, 1, "combat", true);
    assert!(client.try_add_achievement(&user, &ach).is_err());
    assert_eq!(
        client
            .get_achievement_unlock_snapshot(&user)
            .total_achievements,
        0
    );

    let unlock = NextUnlock {
        user: user.clone(),
        next_achievement: OptionalAchievement::Some(ach),
        progress: 10,
    };
    assert!(client.try_set_next_unlock(&user, &unlock).is_err());
    assert!(client.get_next_unlock(&user).is_none());

    assert!(client.try_set_claim_grace_period(&user, &100).is_err());
    assert_eq!(
        client.get_claim_grace_accessor(&user).grace_period_ledger,
        0
    );

    env.mock_all_auths();
    client.add_achievement(&user, &achievement(&env, 2, "exploration", true));
    assert_eq!(
        client
            .get_achievement_unlock_snapshot(&user)
            .total_achievements,
        1
    );
}
