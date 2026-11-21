#![no_std]

//! # Contract Interaction Library
//!
//! A reusable on-chain SDK helper exposing type-safe wrappers, cross-contract
//! call utilities, and event-decoding helpers so that other StellarCade
//! contracts can interact with the ecosystem in a composable, safe way.
//!
//! **Capabilities:**
//! 1. **Registry** – store and resolve canonical contract addresses by name,
//!    with version tracking and activation state.
//! 2. **Upgrade management** – update a registered contract's address while
//!    preserving name-based routing.
//! 3. **Call logging** – emit and persist immutable records of cross-contract
//!    call outcomes for auditability.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Env, Map, String,
};

#[contractclient(name = "ContractAddressRegistryClient")]
pub trait ContractAddressRegistryContract {
    fn resolve(env: Env, name: String) -> Result<Address, RegistryError>;
}

#[contractclient(name = "PrizePoolClient")]
pub trait PrizePoolContract {
    fn get_config_snapshot(env: Env) -> Result<PrizePoolConfigSnapshot, PrizePoolReadError>;
}

#[contractclient(name = "BalanceManagerClient")]
pub trait BalanceManagerContract {
    fn get_account_summary(env: Env, user: Address) -> AccountSummary;
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrizePoolConfigSnapshot {
    pub admin: Address,
    pub token: Address,
    pub available_balance: i128,
    pub reserved_amount: i128,
    pub payouts_count: u64,
    pub last_update_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PrizePoolReadError {
    NotInitialized = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSummary {
    pub exists: bool,
    pub balance: i128,
    pub reserved: i128,
    pub last_update: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAuthorized = 3,
    ContractNotFound = 4,
    InvalidAddress = 5,
    DuplicateRegistration = 6,
    InvalidVersion = 7,
    InvalidName = 8,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CoreReadError {
    RegistryNotInitialized = 1,
    RegistryEntryMissing = 2,
    RegistryLookupFailed = 3,
    CoreReadFailed = 4,
}

// ─── Types ────────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractEntry {
    pub name: String,
    pub address: Address,
    pub version: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallRecord {
    pub callee_name: String,
    pub caller: Address,
    pub timestamp: u64,
    pub success: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Registry,
    CallCounter,
    CallLog,
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[contractevent]
pub struct LibraryInitialized {
    pub admin: Address,
}

#[contractevent]
pub struct ContractRegistered {
    pub name: String,
    pub address: Address,
    pub version: u32,
}

#[contractevent]
pub struct ContractDeactivated {
    pub name: String,
}

#[contractevent]
pub struct CallLogged {
    pub log_id: u64,
    pub callee_name: String,
    pub caller: Address,
    pub success: bool,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct ContractInteractionLibrary;

#[contractimpl]
impl ContractInteractionLibrary {
    /// Initialise the library contract. Must be called once.
    pub fn init(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        let empty: Map<String, ContractEntry> = Map::new(&env);
        env.storage().instance().set(&DataKey::Registry, &empty);
        let empty_log: Map<u64, CallRecord> = Map::new(&env);
        env.storage().instance().set(&DataKey::CallLog, &empty_log);
        env.storage().instance().set(&DataKey::CallCounter, &0u64);
        LibraryInitialized { admin }.publish(&env);
    }

    // ── Registry ──────────────────────────────────────────────────────────────

    /// Register a contract under a human-readable `name` (1-32 chars, unique).
    pub fn register_contract(env: Env, name: String, address: Address, version: u32) {
        Self::require_admin(&env);
        if name.is_empty() || name.len() > 32 {
            panic!("Invalid name: must be 1-32 characters");
        }
        if version == 0 {
            panic!("Invalid version: must be positive");
        }
        let mut registry: Map<String, ContractEntry> = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap_or(Map::new(&env));
        if registry.contains_key(name.clone()) {
            panic!("Contract name already registered");
        }
        let entry = ContractEntry {
            name: name.clone(),
            address: address.clone(),
            version,
            active: true,
        };
        registry.set(name.clone(), entry);
        env.storage().instance().set(&DataKey::Registry, &registry);
        ContractRegistered {
            name,
            address,
            version,
        }
        .publish(&env);
    }

    /// Deactivate a registered contract by name.
    pub fn deactivate_contract(env: Env, name: String) {
        Self::require_admin(&env);
        let mut registry: Map<String, ContractEntry> = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap_or(Map::new(&env));
        let mut entry = registry.get(name.clone()).expect("Contract not found");
        entry.active = false;
        registry.set(name.clone(), entry);
        env.storage().instance().set(&DataKey::Registry, &registry);
        ContractDeactivated { name }.publish(&env);
    }

    /// Upgrade a registered contract to a new address + version.
    pub fn upgrade_contract(env: Env, name: String, new_address: Address, new_version: u32) {
        Self::require_admin(&env);
        if new_version == 0 {
            panic!("Invalid version: must be positive");
        }
        let mut registry: Map<String, ContractEntry> = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap_or(Map::new(&env));
        let mut entry = registry.get(name.clone()).expect("Contract not found");
        entry.address = new_address.clone();
        entry.version = new_version;
        entry.active = true;
        registry.set(name.clone(), entry);
        env.storage().instance().set(&DataKey::Registry, &registry);
    }

    // ── Lookup ────────────────────────────────────────────────────────────────

    /// Return the full registry entry for `name`.
    pub fn get_contract(env: Env, name: String) -> ContractEntry {
        let registry: Map<String, ContractEntry> = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap_or(Map::new(&env));
        registry.get(name).expect("Contract not found")
    }

    /// Resolve the address of an active registered contract.
    pub fn resolve(env: Env, name: String) -> Address {
        let entry = Self::get_contract(env.clone(), name);
        if !entry.active {
            panic!("Contract is inactive");
        }
        entry.address
    }

    // ── Call Logging ──────────────────────────────────────────────────────────

    /// Record a cross-contract call result and return its log ID.
    pub fn log_call(env: Env, callee_name: String, caller: Address, success: bool) -> u64 {
        caller.require_auth();
        let record = CallRecord {
            callee_name: callee_name.clone(),
            caller: caller.clone(),
            timestamp: env.ledger().timestamp(),
            success,
        };
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CallCounter)
            .unwrap_or(0);
        let mut log: Map<u64, CallRecord> = env
            .storage()
            .instance()
            .get(&DataKey::CallLog)
            .unwrap_or(Map::new(&env));
        log.set(id, record);
        env.storage().instance().set(&DataKey::CallLog, &log);
        env.storage()
            .instance()
            .set(&DataKey::CallCounter, &(id + 1));
        CallLogged {
            log_id: id,
            callee_name,
            caller,
            success,
        }
        .publish(&env);
        id
    }

    /// Fetch a call log entry by ID.
    pub fn get_call_log(env: Env, log_id: u64) -> CallRecord {
        let log: Map<u64, CallRecord> = env
            .storage()
            .instance()
            .get(&DataKey::CallLog)
            .unwrap_or(Map::new(&env));
        log.get(log_id).expect("Log entry not found")
    }

    // ── Registry-backed typed reads ─────────────────────────────────────────

    pub fn read_prize_pool_config(
        env: Env,
        address_registry: Address,
    ) -> Result<PrizePoolConfigSnapshot, CoreReadError> {
        let prize_pool = resolve_core(&env, &address_registry, "prize-pool")?;
        match PrizePoolClient::new(&env, &prize_pool).try_get_config_snapshot() {
            Ok(Ok(snapshot)) => Ok(snapshot),
            Ok(Err(_)) => Err(CoreReadError::CoreReadFailed),
            Err(_) => Err(CoreReadError::CoreReadFailed),
        }
    }

    pub fn read_balance_account_summary(
        env: Env,
        address_registry: Address,
        user: Address,
    ) -> Result<AccountSummary, CoreReadError> {
        let balance = resolve_core(&env, &address_registry, "balance-management")?;
        Ok(BalanceManagerClient::new(&env, &balance).get_account_summary(&user))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Not initialized");
        admin.require_auth();
    }
}

fn resolve_core(
    env: &Env,
    address_registry: &Address,
    name: &str,
) -> Result<Address, CoreReadError> {
    let registry = ContractAddressRegistryClient::new(env, address_registry);
    let name = String::from_str(env, name);
    match registry.try_resolve(&name) {
        Ok(Ok(address)) => Ok(address),
        Ok(Err(_)) => Err(CoreReadError::RegistryLookupFailed),
        Err(Ok(RegistryError::NotInitialized)) => Err(CoreReadError::RegistryNotInitialized),
        Err(Ok(RegistryError::ContractNotFound)) => Err(CoreReadError::RegistryEntryMissing),
        Err(Ok(_)) => Err(CoreReadError::RegistryLookupFailed),
        Err(Err(_)) => Err(CoreReadError::RegistryLookupFailed),
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod test;
