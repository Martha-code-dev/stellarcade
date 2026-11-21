# @stellarcade/auth-signature-linter

Static analysis linter that scans Soroban contract Rust source files for state-mutating functions missing a `require_auth()` (or `require_auth_for_args()`) check on their `Address` caller parameter.

## Features

- Scans every `src/lib.rs` under a directory, recursively
- Identifies `pub fn` implementations and their `Address`-typed parameters
- Distinguishes actor addresses (must authorize) from beneficiary addresses (must not be asked to authorize)
- Treats a state mutation with no `Address` argument and read-only accessors as out of scope
- Follows same-file helpers transitively: a mutation reached through helpers is still in scope, and authorization delegated to a helper that calls `require_auth()` on the actor counts
- Reports an unclassified `Address` parameter as a violation rather than guessing its role
- Flags a function as mutating when it calls `.set()`, `.remove()`, `.update()`, or `.extend_ttl()` on instance, persistent, or temporary storage, directly or via a helper
- Reports exact file + line number and a remediation suggestion per violation
- `--fail-on-warning` for CI gating (exit code 1 on any violation)

## Installation

```bash
npm install @stellarcade/auth-signature-linter
```

## Usage

```bash
auth-signature-linter --contracts-dir ./contracts
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--contracts-dir <path>` | Directory to scan for `lib.rs` files (recursively) | (required) |
| `--fail-on-warning` | Exit code 1 if any violation is found | `false` |
| `-V, --version` | Output the version number | |
| `-h, --help` | Display help for command | |

### Example rule check

Given:

```rust
pub fn withdraw_all(env: Env, caller: Address) {
    env.storage().instance().set(&caller, &0i128);
}
```

the linter reports:

```
✗ src/lib.rs:1: Function 'withdraw_all' mutates storage but never calls 'caller.require_auth()'
    Add 'caller.require_auth();' before the storage mutation, call an authorization helper with 'caller', or confirm 'caller' is a beneficiary via '// auth-linter: beneficiary caller'.
```

Adding the check silences the violation:

```rust
pub fn withdraw_all(env: Env, caller: Address) {
    caller.require_auth();
    env.storage().instance().set(&caller, &0i128);
}
```

### Roles and helpers

By default, parameter names such as `caller`, `from`, `player`, and `owner` are
treated as actors that must authorize, while `to`, `recipient`, and `payee` are
treated as beneficiaries that must not. For any other name, or to override the
default, annotate the function directly above its signature:

```rust
// auth-linter: beneficiary payee
pub fn credit(env: Env, payee: Address, amount: i128) {
    env.storage().persistent().set(&payee, &amount);
}
```

An unannotated, unrecognized `Address` parameter is reported so the role is
explicit. Authorization may also be delegated to a same-file helper that calls
`require_auth()` on the actor passed to it:

```rust
pub fn withdraw(env: Env, caller: Address) {
    authorize(&env, &caller);
    env.storage().instance().set(&caller, &0i128);
}

fn authorize(env: Env, who: Address) {
    who.require_auth();
}
```

### CI gating

```bash
auth-signature-linter --contracts-dir ./contracts --fail-on-warning
```

## Scope note

This is a lightweight lexical scanner, not a full Rust parser or the
Soroban SDK's own macro expansion. It deliberately does not attempt to
handle every possible shape a contract could take:

- Only a bare `name: Address` parameter is recognized as a caller identity. An `Address` wrapped in a custom struct, `Option<Address>`, or reached via a type alias is not detected.
- `&Address` reference parameters are excluded, since Soroban host bindings pass `Address` by value for the "authorizing caller" convention this linter checks.
- Functions generated entirely by a macro (rather than appearing as literal `pub fn` source) are not visible to a source-level scan.

These gaps are conservative in the safe direction (under-flagging, not
over-flagging) and are documented here rather than silently assumed.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Run in development mode
npm run dev
```

## License

MIT
