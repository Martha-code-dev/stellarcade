import { extractCalls } from './ast-scanner';
import type { AddressRole, AuthContext, FunctionInfo, Violation } from './types';

// Any of these calls mutate contract storage, which is why this linter
// treats a function containing one as "state-mutating" and in scope for the
// auth check. A pure read-only accessor (only `.get()`/`.has()`) is not.
const STORAGE_WRITE_PATTERNS = [
  /\.storage\(\)\s*\.\s*(?:instance|persistent|temporary)\(\)\s*\.\s*set\s*\(/,
  /\.storage\(\)\s*\.\s*(?:instance|persistent|temporary)\(\)\s*\.\s*remove\s*\(/,
  /\.storage\(\)\s*\.\s*(?:instance|persistent|temporary)\(\)\s*\.\s*update\s*\(/,
  /\.storage\(\)\s*\.\s*(?:instance|persistent|temporary)\(\)\s*\.\s*extend_ttl\s*\(/,
];

// Names that conventionally identify the party acting (and therefore
// authorizing). Matched case-insensitively; explicit source annotations win.
const ACTOR_PARAM_NAMES = new Set([
  'caller', 'from', 'player', 'user', 'admin', 'owner', 'authority',
  'signer', 'actor', 'sender', 'agent', 'initiator', 'operator',
]);

// Names that identify a party receiving value or state. Such a party cannot
// be expected to sign a transaction it did not initiate, so requiring their
// auth is a false positive. Explicit source annotations win.
const BENEFICIARY_PARAM_NAMES = new Set([
  'to', 'recipient', 'beneficiary', 'receiver', 'destination', 'target', 'payee',
]);

const EMPTY_CONTEXT: AuthContext = {
  mutatingHelpers: new Set(),
  authorizingHelpers: new Map(),
};

/**
 * Whether `body` writes to contract storage directly, or calls a known helper
 * that does (transitively, via `context.mutatingHelpers`).
 */
export function isStateMutating(body: string, context: AuthContext = EMPTY_CONTEXT): boolean {
  if (STORAGE_WRITE_PATTERNS.some((re) => re.test(body))) return true;
  return extractCalls(body).some((call) => context.mutatingHelpers.has(call.name));
}

/** Whether `body` calls `.require_auth()` (or `.require_auth_for_args()`) on `paramName`. */
export function hasRequireAuthCall(body: string, paramName: string): boolean {
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\s*\\.\\s*require_auth(?:_for_args)?\\s*\\(`);
  return re.test(body);
}

/** Classify an Address parameter by explicit annotation first, then by name convention. */
export function classifyAddressParam(
  name: string,
  annotations: Record<string, AddressRole> = {}
): AddressRole {
  const explicit = annotations[name];
  if (explicit === 'actor' || explicit === 'beneficiary' || explicit === 'unknown') return explicit;
  const lowered = name.toLowerCase();
  if (ACTOR_PARAM_NAMES.has(lowered)) return 'actor';
  if (BENEFICIARY_PARAM_NAMES.has(lowered)) return 'beneficiary';
  return 'unknown';
}

/**
 * Build the file-level context the rule needs: which helpers mutate storage
 * (directly or through another helper) and which helper parameter positions
 * perform their own authorization.
 */
export function buildAuthContext(functions: FunctionInfo[]): AuthContext {
  const mutatingHelpers = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      if (mutatingHelpers.has(fn.name)) continue;
      const inlineWrite = STORAGE_WRITE_PATTERNS.some((re) => re.test(fn.body));
      const viaHelper = (fn.calls ?? []).some((call) => mutatingHelpers.has(call.name));
      if (inlineWrite || viaHelper) {
        mutatingHelpers.add(fn.name);
        changed = true;
      }
    }
  }

  const authorizingHelpers = new Map<string, Set<number>>();
  for (const fn of functions) {
    const indexes = new Set<number>();
    (fn.allParams ?? fn.addressParams).forEach((param, index) => {
      if (fn.addressParams.includes(param) && hasRequireAuthCall(fn.body, param)) {
        indexes.add(index);
      }
    });
    if (indexes.size > 0) authorizingHelpers.set(fn.name, indexes);
  }

  return { mutatingHelpers, authorizingHelpers };
}

/** Normalize a call argument for comparison: drop leading borrow operators. */
function normalizeArg(arg: string | undefined): string {
  return (arg ?? '').trim().replace(/^&+\s*/, '');
}

/**
 * True when an actor address is authorized either inline or by a helper that
 * calls require_auth on the argument passed at the matching position.
 */
function isAuthorized(fn: FunctionInfo, param: string, context: AuthContext): boolean {
  if (hasRequireAuthCall(fn.body, param)) return true;
  for (const call of fn.calls ?? []) {
    const authorizedIndexes = context.authorizingHelpers.get(call.name);
    if (!authorizedIndexes) continue;
    for (const index of authorizedIndexes) {
      if (normalizeArg(call.args[index]) === param) return true;
    }
  }
  return false;
}

/**
 * Apply the auth-signature rule to one scanned function. Beneficiaries are
 * never asked to authorize; unclassified addresses are reported so the author
 * has to state their role explicitly.
 */
export function checkFunction(fn: FunctionInfo, context: AuthContext = EMPTY_CONTEXT): Violation[] {
  if (fn.addressParams.length === 0) return [];
  if (!isStateMutating(fn.body, context)) return [];

  const violations: Violation[] = [];
  for (const param of fn.addressParams) {
    const role = classifyAddressParam(param, fn.roleAnnotations);

    if (role === 'beneficiary') continue;

    if (role === 'unknown') {
      violations.push({
        filePath: fn.filePath,
        functionName: fn.name,
        line: fn.line,
        severity: 'error',
        message: `Address parameter '${param}' in '${fn.name}' has no authorization role`,
        remediation: `Add '// auth-linter: actor ${param}' or '// auth-linter: beneficiary ${param}' above the function so the rule can tell whether '${param}' must authorize.`,
      });
      continue;
    }

    if (!isAuthorized(fn, param, context)) {
      violations.push({
        filePath: fn.filePath,
        functionName: fn.name,
        line: fn.line,
        severity: 'error',
        message: `Function '${fn.name}' mutates storage but never calls '${param}.require_auth()'`,
        remediation: `Add '${param}.require_auth();' before the storage mutation, call an authorization helper with '${param}', or confirm '${param}' is a beneficiary via '// auth-linter: beneficiary ${param}'.`,
      });
    }
  }
  return violations;
}

export function checkAll(functions: FunctionInfo[]): Violation[] {
  const context = buildAuthContext(functions);
  return functions
    .filter((fn) => fn.isPublic !== false)
    .flatMap((fn) => checkFunction(fn, context));
}
