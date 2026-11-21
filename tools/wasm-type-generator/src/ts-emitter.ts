import {
  ContractSpecResult,
  SorobanType,
  SpecEnum,
  SpecFunction,
  SpecStruct,
  SpecUnion
} from './wasm-parser';

const TS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'as', 'implements', 'interface', 'let', 'package', 'private', 'protected', 'public',
  'static', 'yield', 'any', 'boolean', 'constructor', 'declare', 'get', 'module',
  'require', 'number', 'set', 'string', 'symbol', 'type', 'from', 'of', 'unknown',
  'never', 'object', 'undefined'
]);

function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !TS_RESERVED.has(name);
}

function sanitizeIdentifier(name: string, fallback = '_'): string {
  let safe = name.replace(/[^A-Za-z0-9_$]/g, '_');
  if (safe.length === 0) safe = fallback;
  if (/^[0-9]/.test(safe)) safe = `_${safe}`;
  if (TS_RESERVED.has(safe)) safe = `${safe}_`;
  return safe;
}

function escapeStringLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeDocComment(value: string): string {
  return value.replace(/\*\//g, '*\\/');
}

function formatPropertyName(name: string): string {
  if (isValidIdentifier(name)) return name;
  return `'${escapeStringLiteral(name)}'`;
}

function formatMethodName(name: string): string {
  if (isValidIdentifier(name)) return name;
  return `'${escapeStringLiteral(name)}'`;
}

function formatEnumMemberName(name: string): string {
  if (isValidIdentifier(name)) return name;
  // Enum members in TS can be string-named; keep exact original name safely quoted.
  return `'${escapeStringLiteral(name)}'`;
}

export function sorobanTypeToTs(type: SorobanType): string {
  switch (type.kind) {
    case 'val': return 'unknown';
    case 'bool': return 'boolean';
    case 'void': return 'void';
    case 'error': return 'Error';
    case 'u32':
    case 'i32': return 'number';
    case 'u64':
    case 'i64':
    case 'u128':
    case 'i128':
    case 'u256':
    case 'i256':
    case 'timepoint':
    case 'duration': return 'bigint';
    case 'bytes':
    case 'bytesN': return 'Uint8Array';
    case 'string':
    case 'symbol':
    case 'address': return 'string';
    case 'option': return `${sorobanTypeToTs(type.valueType)} | null`;
    case 'result': return `{ ok: ${sorobanTypeToTs(type.okType)} } | { err: ${sorobanTypeToTs(type.errorType)} }`;
    case 'vec': return `Array<${sorobanTypeToTs(type.elementType)}>`;
    case 'map': return `Map<${sorobanTypeToTs(type.keyType)}, ${sorobanTypeToTs(type.valueType)}>`;
    case 'tuple': return `[${type.elementTypes.map(sorobanTypeToTs).join(', ')}]`;
    case 'udt': return sanitizeIdentifier(type.name, 'UnknownType');
    default: return 'unknown';
  }
}

export function generateTypeScriptDefinitions(specResult: ContractSpecResult): string {
  const lines: string[] = [];

  lines.push('/**');
  lines.push(' * Auto-generated Soroban Contract TypeScript Definitions');
  if (specResult.envMeta) {
    lines.push(` * Soroban Protocol Version: ${specResult.envMeta.protocolVersion}`);
  }
  lines.push(' */\n');

  const structs: SpecStruct[] = [];
  const enums: SpecEnum[] = [];
  const unions: SpecUnion[] = [];
  const functions: SpecFunction[] = [];

  for (const entry of specResult.specEntries) {
    if (entry.kind === 'struct') structs.push(entry);
    else if (entry.kind === 'enum') enums.push(entry);
    else if (entry.kind === 'union') unions.push(entry);
    else if (entry.kind === 'function') functions.push(entry);
  }

  // Generate Enums
  for (const item of enums) {
    if (item.doc) {
      lines.push(`/** ${escapeDocComment(item.doc)} */`);
    }
    lines.push(`export enum ${sanitizeIdentifier(item.name, 'Enum')} {`);
    for (const c of item.cases) {
      if (c.doc) lines.push(`  /** ${escapeDocComment(c.doc)} */`);
      lines.push(`  ${formatEnumMemberName(c.name)} = ${c.value},`);
    }
    lines.push('}\n');
  }

  // Generate Structs
  for (const item of structs) {
    if (item.doc) {
      lines.push(`/** ${escapeDocComment(item.doc)} */`);
    }
    lines.push(`export interface ${sanitizeIdentifier(item.name, 'Struct')} {`);
    for (const f of item.fields) {
      if (f.doc) lines.push(`  /** ${escapeDocComment(f.doc)} */`);
      lines.push(`  ${formatPropertyName(f.name)}: ${sorobanTypeToTs(f.type)};`);
    }
    lines.push('}\n');
  }

  // Generate Unions
  for (const item of unions) {
    if (item.doc) {
      lines.push(`/** ${escapeDocComment(item.doc)} */`);
    }
    const unionParts = item.cases.map((c) => {
      const tag = `'${escapeStringLiteral(c.name)}'`;
      const types = c.types ?? [];
      if (types.length === 1) {
        return `{ tag: ${tag}; value: ${sorobanTypeToTs(types[0])} }`;
      }
      if (types.length > 1) {
        return `{ tag: ${tag}; values: [${types.map(sorobanTypeToTs).join(', ')}] }`;
      }
      return `{ tag: ${tag} }`;
    });
    lines.push(`export type ${sanitizeIdentifier(item.name, 'Union')} = ${unionParts.join(' | ') || 'never'};\n`);
  }

  // Generate Contract Client Interface
  lines.push('export interface SorobanContractClient {');
  for (const fn of functions) {
    if (fn.doc) {
      lines.push(`  /** ${escapeDocComment(fn.doc)} */`);
    }
    const used = new Set<string>();
    const params = fn.inputs.map((inp, idx) => {
      let paramName = sanitizeIdentifier(inp.name || `arg${idx}`, `arg${idx}`);
      if (used.has(paramName)) {
        let i = 2;
        while (used.has(`${paramName}_${i}`)) i++;
        paramName = `${paramName}_${i}`;
      }
      used.add(paramName);
      return `${paramName}: ${sorobanTypeToTs(inp.type)}`;
    }).join(', ');
    const returnType = fn.outputs.length > 0
      ? fn.outputs.map(sorobanTypeToTs).join(' | ')
      : 'void';
    lines.push(`  ${formatMethodName(fn.name)}(${params}): Promise<${returnType}>;`);
  }
  lines.push('}');

  return lines.join('\n');
}
