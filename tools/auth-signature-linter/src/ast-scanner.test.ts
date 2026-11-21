import { describe, it, expect } from 'vitest';
import { scanFunctions, scanHelpers, extractCalls } from './ast-scanner';

describe('scanFunctions', () => {
  it('extracts a simple pub fn with an Address parameter', () => {
    const source = `
      pub fn withdraw(env: Env, caller: Address, amount: i128) {
          caller.require_auth();
          env.storage().instance().set(&DataKey::Balance, &amount);
      }
    `;
    const fns = scanFunctions(source, 'lib.rs');

    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('withdraw');
    expect(fns[0].addressParams).toEqual(['caller']);
    expect(fns[0].body).toContain('require_auth');
  });

  it('ignores non-Address parameters', () => {
    const source = `
      pub fn get_balance(env: Env, id: u64) -> i128 {
          0
      }
    `;
    const fns = scanFunctions(source, 'lib.rs');
    expect(fns[0].addressParams).toEqual([]);
  });

  it('detects multiple Address parameters on one function', () => {
    const source = `
      pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
          from.require_auth();
      }
    `;
    const fns = scanFunctions(source, 'lib.rs');
    expect(fns[0].addressParams).toEqual(['from', 'to']);
  });

  it('does not treat a &Address reference parameter as an Address param', () => {
    const source = `
      pub fn peek(env: Env, who: &Address) -> bool {
          true
      }
    `;
    const fns = scanFunctions(source, 'lib.rs');
    expect(fns[0].addressParams).toEqual([]);
  });

  it('correctly captures nested braces inside the function body', () => {
    const source = `
      pub fn complex(env: Env, caller: Address) {
          caller.require_auth();
          if true {
              let x = { 1 + 1 };
              env.storage().instance().set(&DataKey::X, &x);
          }
      }
      pub fn after() {}
    `;
    const fns = scanFunctions(source, 'lib.rs');
    expect(fns).toHaveLength(2);
    expect(fns[0].name).toBe('complex');
    expect(fns[0].body).toContain('let x = { 1 + 1 };');
    expect(fns[1].name).toBe('after');
  });

  it('scans multiple functions across a file and reports correct line numbers', () => {
    const source = [
      '// comment',
      'pub fn first(env: Env, a: Address) {',
      '    a.require_auth();',
      '}',
      '',
      'pub fn second(env: Env, b: Address) {',
      '    b.require_auth();',
      '}',
    ].join('\n');
    const fns = scanFunctions(source, 'lib.rs');

    expect(fns.map((f) => f.name)).toEqual(['first', 'second']);
    expect(fns[0].line).toBe(2);
    expect(fns[1].line).toBe(6);
  });

  it('returns an empty list for source with no pub fn', () => {
    const source = `fn private_helper() {}`;
    expect(scanFunctions(source, 'lib.rs')).toEqual([]);
  });

  it('captures allParams in order and per-function role annotations', () => {
    const source = [
      '// auth-linter: beneficiary to',
      'pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {',
      '    from.require_auth();',
      '}',
    ].join('\n');
    const fns = scanFunctions(source, 'lib.rs');
    expect(fns[0].allParams).toEqual(['env', 'from', 'to', 'amount']);
    expect(fns[0].roleAnnotations).toEqual({ to: 'beneficiary' });
  });
});

describe('scanHelpers', () => {
  it('returns only private functions and records their address params and calls', () => {
    const source = [
      'pub fn entry(env: Env, caller: Address) {',
      '    authorize(&env, &caller);',
      '}',
      'fn authorize(env: Env, who: Address) {',
      '    who.require_auth();',
      '}',
    ].join('\n');

    expect(scanFunctions(source, 'lib.rs').map((f) => f.name)).toEqual(['entry']);
    const helpers = scanHelpers(source, 'lib.rs');
    expect(helpers.map((f) => f.name)).toEqual(['authorize']);
    expect(helpers[0].addressParams).toEqual(['who']);
    expect(helpers[0].allParams).toEqual(['env', 'who']);
    expect(helpers[0].calls).toEqual([]);
  });
});

describe('extractCalls', () => {
  it('captures same-file helper calls with their positional args', () => {
    const body = 'authorize(&env, &caller); write_balance(&env, &caller, 0i128);';
    expect(extractCalls(body)).toEqual([
      { name: 'authorize', args: ['&env', '&caller'] },
      { name: 'write_balance', args: ['&env', '&caller', '0i128'] },
    ]);
  });

  it('splits nested call arguments correctly', () => {
    const body = 'wrap(outer(1, 2), caller);';
    expect(extractCalls(body)).toEqual([
      { name: 'wrap', args: ['outer(1, 2)', 'caller'] },
      { name: 'outer', args: ['1', '2'] },
    ]);
  });

  it('ignores language constructs and storage methods that are not helper functions', () => {
    const body = 'if true { env.storage().instance().set(&k, &v); } caller.require_auth();';
    const names = extractCalls(body).map((call) => call.name);
    expect(names).not.toContain('if');
    expect(names).not.toContain('storage');
    expect(names).not.toContain('set');
    expect(names).not.toContain('require_auth');
  });
});
