use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env};

struct Setup {
    env: Env,
    admin: Address,
    client: RoundVouchersClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let contract_id = env.register(RoundVouchers, ());
    let client = RoundVouchersClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.init(&admin);
    let client: RoundVouchersClient<'static> = unsafe { core::mem::transmute(client) };
    Setup { env, admin, client }
}

#[test]
fn issuance_summary_tracks_round_supply_and_redemptions() {
    let s = setup();
    s.client
        .upsert_round(&s.admin, &3u32, &2u64, &2_000u64, &false);
    s.client.issue_voucher(&s.admin, &11u64, &3u32);
    s.client.issue_voucher(&s.admin, &12u64, &3u32);

    let before = s.client.voucher_issuance_summary(&3u32);
    assert_eq!(before.total_issued, 2);
    assert_eq!(before.remaining, 0);
    assert_eq!(before.total_redeemed, 0);

    s.env.ledger().set_timestamp(2_100);
    s.client.redeem_voucher(&s.admin, &11u64);
    let after = s.client.voucher_issuance_summary(&3u32);
    assert_eq!(after.total_redeemed, 1);
}

#[test]
fn redemption_gap_accessor_reports_missing_and_countdown() {
    let s = setup();
    let missing = s.client.redemption_gap_accessor(&404u64);
    assert!(!missing.exists);

    s.client
        .upsert_round(&s.admin, &5u32, &0u64, &5_000u64, &false);
    s.client.issue_voucher(&s.admin, &77u64, &5u32);
    let before = s.client.redemption_gap_accessor(&77u64);
    assert!(before.exists);
    assert_eq!(before.seconds_until_redeemable, 4_000);

    s.env.ledger().set_timestamp(5_500);
    let after = s.client.redemption_gap_accessor(&77u64);
    assert_eq!(after.seconds_until_redeemable, 0);
}

#[test]
fn test_unauthorized_and_invariants() {
    let s = setup();
    let non_admin = Address::generate(&s.env);

    // Non-admin cannot upsert round
    let res = s
        .client
        .try_upsert_round(&non_admin, &1u32, &10u64, &2_000u64, &false);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));

    // Upsert round by admin
    s.client
        .upsert_round(&s.admin, &1u32, &1u64, &2_000u64, &false);

    // Non-admin cannot issue voucher
    let res = s.client.try_issue_voucher(&non_admin, &100u64, &1u32);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));

    // Admin issues voucher
    s.client.issue_voucher(&s.admin, &100u64, &1u32);

    // Exceeding supply
    let res = s.client.try_issue_voucher(&s.admin, &101u64, &1u32);
    assert_eq!(res, Err(Ok(Error::SupplyExhausted)));

    // Non-admin cannot redeem voucher
    let res = s.client.try_redeem_voucher(&non_admin, &100u64);
    assert_eq!(res, Err(Ok(Error::NotAuthorized)));

    // Admin tries to redeem before redeemable_after
    let res = s.client.try_redeem_voucher(&s.admin, &100u64);
    assert_eq!(res, Err(Ok(Error::RedemptionNotOpen)));

    // Warp past redeemable_after and redeem
    s.env.ledger().set_timestamp(2_500);
    let res = s.client.try_redeem_voucher(&s.admin, &100u64);
    assert!(res.is_ok());

    // Already redeemed
    let res = s.client.try_redeem_voucher(&s.admin, &100u64);
    assert_eq!(res, Err(Ok(Error::AlreadyRedeemed)));
}
