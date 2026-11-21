import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { lintDirectory } from './index';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

describe('lintDirectory (integration)', () => {
  it('flags the vulnerable mock contract for its missing require_auth() check', () => {
    const result = lintDirectory(path.join(FIXTURES_DIR, 'vulnerable-contract'));

    expect(result.filesScanned).toBe(1);
    expect(result.functionsScanned).toBe(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].functionName).toBe('withdraw_all');
    expect(result.violations[0].message).toContain('caller.require_auth()');
  });

  it('passes the secure mock contract with zero violations', () => {
    const result = lintDirectory(path.join(FIXTURES_DIR, 'secure-contract'));

    expect(result.filesScanned).toBe(1);
    expect(result.functionsScanned).toBe(2);
    expect(result.violations).toEqual([]);
  });

  it('passes the role-aware contract: beneficiaries, helpers and read-only accessors are false positives', () => {
    const result = lintDirectory(path.join(FIXTURES_DIR, 'role-aware-contract'));

    expect(result.filesScanned).toBe(1);
    expect(result.functionsScanned).toBe(5);
    expect(result.violations).toEqual([]);
  });

  it('flags the nested-write contract: transitive mutation without auth and an unclassified address', () => {
    const result = lintDirectory(path.join(FIXTURES_DIR, 'nested-write-contract'));

    expect(result.filesScanned).toBe(1);
    expect(result.functionsScanned).toBe(2);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.functionName).sort()).toEqual(['adjust', 'drain']);
    const adjust = result.violations.find((v) => v.functionName === 'adjust');
    expect(adjust?.message).toContain('has no authorization role');
  });

  it('scans the whole fixtures tree and only reports the genuinely vulnerable functions', () => {
    const result = lintDirectory(FIXTURES_DIR);

    expect(result.filesScanned).toBe(4);
    expect(result.violations).toHaveLength(3);
    expect(result.violations.map((v) => v.filePath).some((p) => p.includes('vulnerable-contract'))).toBe(true);
    expect(result.violations.map((v) => v.filePath).some((p) => p.includes('nested-write-contract'))).toBe(true);
    expect(result.violations.map((v) => v.filePath).some((p) => p.includes('role-aware-contract'))).toBe(false);
  });
});
