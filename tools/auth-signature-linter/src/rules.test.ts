import { describe, it, expect } from 'vitest';
import {
  isStateMutating,
  hasRequireAuthCall,
  classifyAddressParam,
  buildAuthContext,
  checkFunction,
  checkAll,
} from './rules';
import type { FunctionInfo } from './types';

function fn(overrides: Partial<FunctionInfo> = {}): FunctionInfo {
  return {
    name: 'withdraw',
    filePath: 'lib.rs',
    line: 10,
    addressParams: ['caller'],
    allParams: ['env', 'caller'],
    body: '',
    bodyStartLine: 10,
    isPublic: true,
    calls: [],
    roleAnnotations: {},
    ...overrides,
  };
}

function helper(overrides: Partial<FunctionInfo> = {}): FunctionInfo {
  return fn({ name: 'helper', isPublic: false, ...overrides });
}

describe('isStateMutating', () => {
  it('detects instance storage set', () => {
    expect(isStateMutating('env.storage().instance().set(&k, &v);')).toBe(true);
  });

  it('detects persistent storage remove', () => {
    expect(isStateMutating('env.storage().persistent().remove(&k);')).toBe(true);
  });

  it('detects temporary storage update', () => {
    expect(isStateMutating('env.storage().temporary().update(&k, &f);')).toBe(true);
  });

  it('returns false for a read-only body', () => {
    expect(isStateMutating('env.storage().instance().get(&k).unwrap_or(0)')).toBe(false);
  });

  it('detects a call to a known mutating helper', () => {
    const context = buildAuthContext([helper({ body: 'env.storage().instance().set(&k, &v);' })]);
    expect(isStateMutating('helper(&k, &v);', context)).toBe(true);
  });

  it('does not treat an arbitrary call as a storage write', () => {
    const context = buildAuthContext([helper({ body: 'let x = 1;' })]);
    expect(isStateMutating('helper();', context)).toBe(false);
  });
});

describe('hasRequireAuthCall', () => {
  it('detects require_auth on the given parameter name', () => {
    expect(hasRequireAuthCall('caller.require_auth();', 'caller')).toBe(true);
  });

  it('detects require_auth_for_args as an equivalent check', () => {
    expect(hasRequireAuthCall('caller.require_auth_for_args(args);', 'caller')).toBe(true);
  });

  it('does not match a different variable name containing the parameter as a substring', () => {
    expect(hasRequireAuthCall('other_caller.require_auth();', 'caller')).toBe(false);
  });

  it('returns false when there is no require_auth call at all', () => {
    expect(hasRequireAuthCall('env.storage().instance().set(&k, &v);', 'caller')).toBe(false);
  });
});

describe('classifyAddressParam', () => {
  it('recognizes actor and beneficiary names', () => {
    expect(classifyAddressParam('caller')).toBe('actor');
    expect(classifyAddressParam('recipient')).toBe('beneficiary');
  });

  it('leaves unrecognized names unknown until annotated explicitly', () => {
    expect(classifyAddressParam('mystery')).toBe('unknown');
    expect(classifyAddressParam('mystery', { mystery: 'beneficiary' })).toBe('beneficiary');
    expect(classifyAddressParam('to', { to: 'actor' })).toBe('actor');
  });
});

describe('buildAuthContext', () => {
  it('follows nested helper writes transitively', () => {
    const writer = helper({ name: 'write', body: 'env.storage().instance().set(&k, &v);' });
    const middle = helper({ name: 'middle', calls: [{ name: 'write', args: ['&k', '&v'] }] });
    const context = buildAuthContext([writer, middle]);
    expect(context.mutatingHelpers.has('write')).toBe(true);
    expect(context.mutatingHelpers.has('middle')).toBe(true);
  });

  it('records the parameter position a helper authorizes', () => {
    const authorize = helper({
      name: 'authorize',
      addressParams: ['who'],
      allParams: ['env', 'who'],
      body: 'who.require_auth();',
    });
    const context = buildAuthContext([authorize]);
    expect([...context.authorizingHelpers.get('authorize') ?? []]).toEqual([1]);
  });
});

describe('checkFunction', () => {
  it('flags a mutating function with an unauthorized actor (vulnerable)', () => {
    const f = fn({
      body: 'env.storage().instance().set(&DataKey::Balance(caller.clone()), &amount);',
    });
    const violations = checkFunction(f);
    expect(violations).toHaveLength(1);
    expect(violations[0].functionName).toBe('withdraw');
    expect(violations[0].message).toContain('caller.require_auth()');
  });

  it('passes a mutating function that calls require_auth (secure)', () => {
    const f = fn({
      body: 'caller.require_auth(); env.storage().instance().set(&DataKey::Balance, &amount);',
    });
    expect(checkFunction(f)).toEqual([]);
  });

  it('ignores read-only accessor functions entirely, even with an Address param', () => {
    const f = fn({ body: 'env.storage().instance().get(&DataKey::Balance(caller)).unwrap_or(0)' });
    expect(checkFunction(f)).toEqual([]);
  });

  it('ignores functions with no Address parameter', () => {
    const f = fn({
      addressParams: [],
      allParams: ['env'],
      body: 'env.storage().instance().set(&DataKey::Counter, &1);',
    });
    expect(checkFunction(f)).toEqual([]);
  });

  it('does not require authorization from a beneficiary address', () => {
    const f = fn({
      addressParams: ['from', 'to'],
      allParams: ['env', 'from', 'to'],
      body: 'from.require_auth(); env.storage().persistent().set(&k, &v);',
    });
    expect(checkFunction(f)).toEqual([]);
  });

  it('still flags a second unauthorized actor independently', () => {
    const f = fn({
      addressParams: ['from', 'admin'],
      allParams: ['env', 'from', 'admin'],
      body: 'from.require_auth(); env.storage().persistent().set(&k, &v);',
    });
    const violations = checkFunction(f);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("'admin.require_auth()'");
  });

  it('honors an explicit beneficiary annotation on an actor-named parameter', () => {
    const f = fn({
      addressParams: ['from'],
      allParams: ['env', 'from'],
      roleAnnotations: { from: 'beneficiary' },
      body: 'env.storage().instance().set(&k, &v);',
    });
    expect(checkFunction(f)).toEqual([]);
  });

  it('reports an unclassified Address parameter instead of guessing', () => {
    const f = fn({
      addressParams: ['mystery'],
      allParams: ['env', 'mystery'],
      body: 'env.storage().instance().set(&k, &v);',
    });
    const violations = checkFunction(f);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('has no authorization role');
    expect(violations[0].remediation).toContain('auth-linter: actor mystery');
  });

  it('accepts authorization delegated to a known helper', () => {
    const authorize = helper({
      name: 'authorize',
      addressParams: ['who'],
      allParams: ['env', 'who'],
      body: 'who.require_auth();',
    });
    const context = buildAuthContext([authorize]);
    const f = fn({
      calls: [{ name: 'authorize', args: ['env', 'caller'] }],
      body: 'authorize(&env, &caller); env.storage().instance().set(&k, &v);',
    });
    expect(checkFunction(f, context)).toEqual([]);
  });

  it('matches helper args that carry a borrow operator (authorize(&env, &caller))', () => {
    const authorize = helper({
      name: 'authorize',
      addressParams: ['who'],
      allParams: ['env', 'who'],
      body: 'who.require_auth();',
    });
    const context = buildAuthContext([authorize]);
    const f = fn({
      calls: [{ name: 'authorize', args: ['&env', '&caller'] }],
      body: 'authorize(&env, &caller); env.storage().instance().set(&k, &v);',
    });
    expect(checkFunction(f, context)).toEqual([]);
  });

  it('flags a helper call with the wrong actor argument', () => {
    const authorize = helper({
      name: 'authorize',
      addressParams: ['who'],
      allParams: ['env', 'who'],
      body: 'who.require_auth();',
    });
    const context = buildAuthContext([authorize]);
    const f = fn({
      calls: [{ name: 'authorize', args: ['env', 'someone_else'] }],
      body: 'authorize(&env, &someone_else); env.storage().instance().set(&k, &v);',
    });
    expect(checkFunction(f, context)).toHaveLength(1);
  });

  it('treats a call to a nested mutating helper as a state mutation', () => {
    const writer = helper({ name: 'write', body: 'env.storage().instance().set(&k, &v);' });
    const middle = helper({ name: 'middle', calls: [{ name: 'write', args: ['&k', '&v'] }] });
    const context = buildAuthContext([writer, middle]);
    const f = fn({
      calls: [{ name: 'middle', args: [] }],
      body: 'middle();',
    });
    expect(checkFunction(f, context)).toHaveLength(1);
  });

  it('does not report private helpers as public entry points', () => {
    const writer = helper({
      body: 'env.storage().instance().set(&k, &v);',
    });
    expect(checkAll([writer])).toEqual([]);
  });

  it('produces exact line numbers and remediation text for CI-actionable output', () => {
    const f = fn({ line: 42, body: 'env.storage().instance().set(&k, &v);' });
    const violations = checkFunction(f);
    expect(violations[0].line).toBe(42);
    expect(violations[0].remediation).toContain('require_auth');
  });
});

describe('checkAll', () => {
  it('aggregates violations across multiple functions', () => {
    const secure = fn({
      name: 'secure_fn',
      body: 'caller.require_auth(); env.storage().instance().set(&k, &v);',
    });
    const vulnerable = fn({
      name: 'vulnerable_fn',
      body: 'env.storage().instance().set(&k, &v);',
    });
    const violations = checkAll([secure, vulnerable]);
    expect(violations).toHaveLength(1);
    expect(violations[0].functionName).toBe('vulnerable_fn');
  });

  it('returns an empty array when given no functions', () => {
    expect(checkAll([])).toEqual([]);
  });
});
