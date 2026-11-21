use soroban_sdk::contracttype;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    /// Vec<PendingPayout>
    Queue,
    /// u32 — payout delay in ledgers applied to every new enqueue
    DelayLedgers,
    /// u32 — pending_count threshold at which overloaded=true
    PressureThreshold,
    Paused,
    FeeSlippage,
}
