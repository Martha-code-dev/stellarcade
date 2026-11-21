export interface FunctionInfo {
  name: string;
  filePath: string;
  /** 1-indexed line the `fn` signature starts on. */
  line: number;
  /** Parameter names typed as `Address` (bare or under a wrapping type is not detected; see README scope note). */
  addressParams: string[];
  /** Every parameter name in declaration order, used to map helper arguments to helper parameters. */
  allParams: string[];
  body: string;
  /** Line number the function body starts on (the line of its opening `{`). */
  bodyStartLine: number;
  /** True for `pub fn`; false for private helpers scanned only as context. Defaults to true for older callers. */
  isPublic?: boolean;
  /** Calls to other functions in the same source file, with their positional argument expressions. */
  calls?: HelperCall[];
  /** Explicit roles from `// auth-linter: actor|beneficiary <name>` comments above the function. */
  roleAnnotations?: Record<string, AddressRole>;
}

export interface HelperCall {
  name: string;
  args: string[];
}

/**
 * `actor` addresses act on behalf of the caller and must authorize.
 * `beneficiary` addresses only receive value or state and must NOT be asked
 * to authorize (a recipient cannot be expected to sign a transaction they did
 * not initiate). `unknown` is reported so the author has to classify it
 * explicitly instead of the linter guessing.
 */
export type AddressRole = 'actor' | 'beneficiary' | 'unknown';

export interface AuthContext {
  /** Function names that write storage directly or through another helper. */
  mutatingHelpers: Set<string>;
  /** Helper name -> zero-based parameter indexes that call require_auth internally. */
  authorizingHelpers: Map<string, Set<number>>;
}

export type ViolationSeverity = 'error';

export interface Violation {
  filePath: string;
  functionName: string;
  line: number;
  severity: ViolationSeverity;
  message: string;
  remediation: string;
}

export interface LintResult {
  filesScanned: number;
  functionsScanned: number;
  violations: Violation[];
}

export interface LinterConfig {
  contractsDir: string;
  failOnWarning: boolean;
}
