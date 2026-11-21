import type { AddressRole, FunctionInfo, HelperCall } from './types';

// Matches `fn name(...)` with an optional `pub` prefix, capturing the name and
// the parameter list up to its closing paren. Deliberately tolerant of
// multi-line signatures (`s` flag) and generic parameters/lifetimes on the
// function name.
const FN_SIGNATURE_RE = /\b(?:pub\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/gs;
const CALL_RE = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

// Names that appear as calls in Rust bodies but are language constructs or
// std/Soroban methods, not same-file helper functions we should follow.
const NON_HELPER_CALLS = new Set([
  'if', 'for', 'while', 'loop', 'match', 'return', 'fn', 'let', 'pub',
  'impl', 'struct', 'enum', 'use', 'mod', 'unsafe', 'move', 'async', 'await',
  'vec', 'format', 'panic', 'assert', 'assert_eq', 'assert_ne', 'unreachable',
  'todo', 'unimplemented', 'Some', 'Ok', 'Err', 'None', 'String', 'Vec',
  'clone', 'unwrap', 'unwrap_or', 'expect', 'get', 'set', 'remove', 'update',
  'extend_ttl', 'storage', 'instance', 'persistent', 'temporary', 'require_auth',
  'require_auth_for_args', 'publish', 'into', 'from', 'as', 'iter', 'map',
]);

/** Scan Rust source for `pub fn`s and their auth-relevant details. */
export function scanFunctions(source: string, filePath: string): FunctionInfo[] {
  return scanAll(source, filePath).filter((fn) => fn.isPublic !== false);
}

/**
 * Scan private `fn`s in the same source. These are not reported directly, but
 * the rules engine uses them to understand helpers that write storage or call
 * `require_auth()` on the caller's behalf.
 */
export function scanHelpers(source: string, filePath: string): FunctionInfo[] {
  return scanAll(source, filePath).filter((fn) => fn.isPublic === false);
}

/** Extract calls to same-file functions together with their argument expressions. */
export function extractCalls(body: string): HelperCall[] {
  const calls: HelperCall[] = [];
  CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_RE.exec(body)) !== null) {
    const name = match[1];
    if (NON_HELPER_CALLS.has(name)) continue;

    const argsStart = match.index + match[0].length;
    let depth = 1;
    let argsEnd = -1;
    for (let i = argsStart; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') {
        depth--;
        if (depth === 0) {
          argsEnd = i;
          break;
        }
      }
    }
    if (argsEnd === -1) continue;
    calls.push({ name, args: splitParams(body.slice(argsStart, argsEnd)).map((arg) => arg.trim()) });
  }
  return calls;
}

function scanAll(source: string, filePath: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = source.split('\n');
  // Precompute cumulative character offsets per line for line-number lookup.
  const lineStarts: number[] = [0];
  for (const line of lines) {
    lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);
  }
  const lineForOffset = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  FN_SIGNATURE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FN_SIGNATURE_RE.exec(source)) !== null) {
    const [full, name, paramList] = match;
    const sigStart = match.index;
    const bodyOpenBrace = source.indexOf('{', sigStart + full.length - 1);
    if (bodyOpenBrace === -1) continue; // trait method declaration with no body, or malformed source: skip

    // Skip past anything between the signature and `{` that isn't a brace
    // (e.g. a `where` clause or `-> ReturnType`) by starting the depth scan
    // exactly at the found `{`.
    let depth = 0;
    let bodyEnd = -1;
    for (let i = bodyOpenBrace; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    if (bodyEnd === -1) continue; // unbalanced braces in malformed source: skip rather than crash

    const body = source.slice(bodyOpenBrace + 1, bodyEnd);
    functions.push({
      name,
      filePath,
      line: lineForOffset(sigStart),
      addressParams: extractAddressParams(paramList),
      allParams: extractAllParams(paramList),
      body,
      bodyStartLine: lineForOffset(bodyOpenBrace),
      isPublic: full.startsWith('pub'),
      calls: extractCalls(body),
      roleAnnotations: extractRoleAnnotations(source, sigStart),
    });
  }

  return functions;
}

/** Extract parameter names declared with a bare `Address` type. */
function extractAddressParams(paramList: string): string[] {
  const addressParams: string[] = [];
  for (const param of splitParams(paramList)) {
    const trimmed = param.trim();
    // Matches `name: Address` or `mut name: Address`, ignoring `&Address`
    // references (Soroban host functions take Address by value, so a `&Address`
    // parameter is not the standard "caller identity" shape this linter targets).
    const m = trimmed.match(/^(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*Address\s*$/);
    if (m) addressParams.push(m[1]);
  }
  return addressParams;
}

/** Every parameter name in declaration order, regardless of type. */
function extractAllParams(paramList: string): string[] {
  const names: string[] = [];
  for (const param of splitParams(paramList)) {
    const m = param.trim().match(/^(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Read `// auth-linter: actor <name>` / `beneficiary <name>` comments above a function. */
function extractRoleAnnotations(source: string, sigStart: number): Record<string, AddressRole> {
  const annotations: Record<string, AddressRole> = {};
  const before = source.slice(0, sigStart).split('\n');
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i].trim();
    if (line === '') continue;
    if (!line.startsWith('//')) break;
    const match = line.match(/^\/\/\s*auth-linter:\s*(actor|beneficiary)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (match) annotations[match[2]] = match[1] as AddressRole;
  }
  return annotations;
}

/** Split a parameter list on top-level commas, respecting nested `<>`/`()` so generic types aren't split mid-way. */
function splitParams(paramList: string): string[] {
  const params: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of paramList) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      params.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) params.push(current);

  return params;
}
