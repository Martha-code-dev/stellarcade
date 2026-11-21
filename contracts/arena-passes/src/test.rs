extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    vec, Address, Env,
};

use crate::{ArenaPasses, ArenaPassesClient, PassHolder};

fn setup() -> (
    Env,
    Address,
    soroban_sdk::Address,
    ArenaPassesClient<'static>,
) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(ArenaPasses, ());
    let client = ArenaPassesClient::new(&env, &id);
    env.mock_all_auths();
    client.init(&admin);
    (env, admin, id, client)
}

#[test]
fn holder_usage_snapshot_success_path() {
    let (env, admin, _id, client) = setup();
    // ledger timestamp = 0; expires_at = 1000 → active
    let holders = vec![
        &env,
        PassHolder {
            holder_index: 0,
            uses_remaining: 5,
            issued_at: 0,
            expires_at: 1000,
        },
        PassHolder {
            holder_index: 1,
            uses_remaining: 3,
            issued_at: 0,
            expires_at: 1000,
        },
    ];
    client.issue_passes(&admin, &holders);
    client.use_pass(&0);

    let snap = client.holder_usage_snapshot();
    assert_eq!(snap.total_holders, 2);
    assert_eq!(snap.active_holders, 2);
    assert_eq!(snap.expired_holders, 0);
    assert_eq!(snap.total_uses_remaining, 7); // 4 + 3
}

#[test]
fn holder_usage_snapshot_empty_state() {
    let (_env, _admin, _id, client) = setup();
    let snap = client.holder_usage_snapshot();
    assert_eq!(snap.total_holders, 0);
    assert_eq!(snap.active_holders, 0);
    assert_eq!(snap.total_uses_remaining, 0);
}

#[test]
fn renewal_window_within_24h_of_expiry() {
    let (env, admin, _id, client) = setup();
    // expires_at = 3600 (1h away); 3600 < 86400 → in renewal window
    let holders = vec![
        &env,
        PassHolder {
            holder_index: 7,
            uses_remaining: 2,
            issued_at: 0,
            expires_at: 3600,
        },
    ];
    client.issue_passes(&admin, &holders);

    let rw = client.renewal_window(&7);
    assert!(rw.is_found);
    assert!(rw.in_renewal_window);
    assert_eq!(rw.seconds_until_expiry, 3600);
}

#[test]
fn renewal_window_not_found_for_unknown_holder() {
    let (_env, _admin, _id, client) = setup();
    let rw = client.renewal_window(&99);
    assert!(!rw.is_found);
    assert!(!rw.in_renewal_window);
    assert_eq!(rw.seconds_until_expiry, 0);
}

// Regression for #1592: an already-expired pass must report zero seconds
// remaining and must not be in the renewal window. The boundary below used a
// manual `if expires_at > now ... else 0` underflow guard that clippy rejected
// under -D warnings; saturating_sub keeps this exact behaviour.
#[test]
fn renewal_window_expired_pass_reports_zero_without_underflow() {
    let (env, admin, _id, client) = setup();
    let holders = vec![
        &env,
        PassHolder {
            holder_index: 3,
            uses_remaining: 1,
            issued_at: 0,
            expires_at: 100,
        },
    ];
    client.issue_passes(&admin, &holders);

    // Advance past expiry.
    env.ledger().with_mut(|li| li.timestamp = 101);
    let rw = client.renewal_window(&3);
    assert!(rw.is_found);
    assert!(!rw.in_renewal_window);
    assert_eq!(rw.seconds_until_expiry, 0);

    // Exactly at expiry is also outside the window with zero seconds left.
    env.ledger().with_mut(|li| li.timestamp = 100);
    let at_boundary = client.renewal_window(&3);
    assert!(at_boundary.is_found);
    assert!(!at_boundary.in_renewal_window);
    assert_eq!(at_boundary.seconds_until_expiry, 0);
}

// Authorization: only the stored admin may replace the pass holders. With all
// auths mocked, require_auth succeeds for anyone, so this proves the
// contract's own admin equality check (not a test stub) enforces the rule.
#[test]
fn issue_passes_by_non_admin_leaves_holders_unchanged() {
    let (env, admin, _id, client) = setup();
    let intruder = Address::generate(&env);
    let holders = vec![
        &env,
        PassHolder {
            holder_index: 1,
            uses_remaining: 2,
            issued_at: 0,
            expires_at: 1000,
        },
    ];

    client.issue_passes(&intruder, &holders);
    assert_eq!(client.holder_usage_snapshot().total_holders, 0);

    // The real admin can still issue them afterwards.
    client.issue_passes(&admin, &holders);
    assert_eq!(client.holder_usage_snapshot().total_holders, 1);
}

// Domain behaviour: using a pass decrements remaining uses once, and a pass
// with no uses left is not consumed again.
#[test]
fn use_pass_decrements_remaining_uses_once() {
    let (env, admin, _id, client) = setup();
    let holders = vec![
        &env,
        PassHolder {
            holder_index: 4,
            uses_remaining: 1,
            issued_at: 0,
            expires_at: 1000,
        },
    ];
    client.issue_passes(&admin, &holders);

    client.use_pass(&4);
    let snap = client.holder_usage_snapshot();
    assert_eq!(snap.total_uses_remaining, 0);

    client.use_pass(&4);
    assert_eq!(client.holder_usage_snapshot().total_uses_remaining, 0);
}
