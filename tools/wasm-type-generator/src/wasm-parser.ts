export type SorobanType =
  | { kind: 'val' }
  | { kind: 'bool' }
  | { kind: 'void' }
  | { kind: 'error' }
  | { kind: 'u32' }
  | { kind: 'i32' }
  | { kind: 'u64' }
  | { kind: 'i64' }
  | { kind: 'u128' }
  | { kind: 'i128' }
  | { kind: 'u256' }
  | { kind: 'i256' }
  | { kind: 'timepoint' }
  | { kind: 'duration' }
  | { kind: 'bytes' }
  | { kind: 'string' }
  | { kind: 'symbol' }
  | { kind: 'address' }
  | { kind: 'option'; valueType: SorobanType }
  | { kind: 'result'; okType: SorobanType; errorType: SorobanType }
  | { kind: 'vec'; elementType: SorobanType }
  | { kind: 'map'; keyType: SorobanType; valueType: SorobanType }
  | { kind: 'tuple'; elementTypes: SorobanType[] }
  | { kind: 'bytesN'; n: number }
  | { kind: 'udt'; name: string };

export interface SpecFunctionInput {
  name: string;
  doc?: string;
  type: SorobanType;
}

export interface SpecFunction {
  kind: 'function';
  name: string;
  doc?: string;
  inputs: SpecFunctionInput[];
  outputs: SorobanType[];
}

export interface StructField {
  name: string;
  doc?: string;
  type: SorobanType;
}

export interface SpecStruct {
  kind: 'struct';
  name: string;
  doc?: string;
  fields: StructField[];
}

export interface EnumCase {
  name: string;
  value: number;
  doc?: string;
}

export interface SpecEnum {
  kind: 'enum';
  name: string;
  doc?: string;
  cases: EnumCase[];
}

export interface UnionCase {
  name: string;
  doc?: string;
  types: SorobanType[]; // zero = void-like, one = single payload, >1 = multi-value
}

export interface SpecUnion {
  kind: 'union';
  name: string;
  doc?: string;
  cases: UnionCase[];
}

export type SpecEntry = SpecFunction | SpecStruct | SpecEnum | SpecUnion;

export interface ContractSpecResult {
  envMeta?: { protocolVersion: number };
  specEntries: SpecEntry[];
}

export class WasmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmParseError';
  }
}

export class XdrDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XdrDecodeError';
  }
}

function readVarUint32(buffer: Buffer, offset: number, limit: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset < limit) {
    const byte = buffer[offset];
    offset += 1;
    bytesRead += 1;
    if (bytesRead > 5) {
      throw new WasmParseError('Malformed LEB128: more than 5 bytes for u32');
    }
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (shift === 28 && (byte & 0x70) !== 0) {
        throw new WasmParseError('Malformed LEB128: u32 overflow');
      }
      return { value: value >>> 0, next: offset };
    }
    shift += 7;
  }
  throw new WasmParseError('Malformed LEB128: truncated value');
}

export function extractWasmCustomSection(wasmBuffer: Buffer, sectionName: string): Buffer[] {
  if (wasmBuffer.length < 8) {
    throw new WasmParseError('Invalid WASM: file too small');
  }
  const magic = wasmBuffer.subarray(0, 4).toString('hex');
  if (magic !== '0061736d') {
    throw new WasmParseError('Invalid WASM: bad magic bytes');
  }
  const version = wasmBuffer.readUInt32LE(4);
  if (version !== 1) {
    throw new WasmParseError(`Invalid WASM: unsupported version ${version}`);
  }

  const sections: Buffer[] = [];
  let offset = 8;
  while (offset < wasmBuffer.length) {
    const sectionId = wasmBuffer[offset++];
    const sizeInfo = readVarUint32(wasmBuffer, offset, wasmBuffer.length);
    offset = sizeInfo.next;
    const sectionSize = sizeInfo.value;
    const sectionEnd = offset + sectionSize;
    if (sectionEnd > wasmBuffer.length) {
      throw new WasmParseError('Invalid WASM: section extends beyond EOF');
    }

    if (sectionId === 0) {
      const nameLenInfo = readVarUint32(wasmBuffer, offset, sectionEnd);
      const nameLen = nameLenInfo.value;
      const nameStart = nameLenInfo.next;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > sectionEnd) {
        throw new WasmParseError('Invalid WASM: custom section name extends beyond section');
      }
      const name = wasmBuffer.subarray(nameStart, nameEnd).toString('utf8');
      if (name === sectionName) {
        sections.push(Buffer.from(wasmBuffer.subarray(nameEnd, sectionEnd)));
      }
    }

    offset = sectionEnd;
  }
  if (offset !== wasmBuffer.length) {
    throw new WasmParseError('Invalid WASM: trailing data after last section');
  }
  return sections;
}

class XdrReader {
  private offset = 0;
  constructor(private buffer: Buffer, private label = 'spec') {}

  get hasMore(): boolean {
    return this.offset < this.buffer.length;
  }

  private require(n: number, what: string): void {
    if (n < 0 || this.offset + n > this.buffer.length) {
      throw new XdrDecodeError(`Truncated ${this.label}: expected ${n} byte(s) for ${what}`);
    }
  }

  readU32(): number {
    this.require(4, 'u32');
    const val = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return val >>> 0;
  }

  readString(): string {
    const len = this.readU32();
    this.require(len, 'string bytes');
    const str = this.buffer.subarray(this.offset, this.offset + len).toString('utf8');
    const padding = (4 - (len % 4)) % 4;
    this.require(padding, 'string padding');
    for (let i = 0; i < padding; i++) {
      if (this.buffer[this.offset + len + i] !== 0) {
        throw new XdrDecodeError(`Invalid ${this.label}: non-zero XDR string padding`);
      }
    }
    this.offset += len + padding;
    return str;
  }

  readTypeDef(): SorobanType {
    const kind = this.readU32();
    switch (kind) {
      case 0: return { kind: 'val' };
      case 1: return { kind: 'bool' };
      case 2: return { kind: 'void' };
      case 3: return { kind: 'error' };
      case 4: return { kind: 'u32' };
      case 5: return { kind: 'i32' };
      case 6: return { kind: 'u64' };
      case 7: return { kind: 'i64' };
      case 8: return { kind: 'timepoint' };
      case 9: return { kind: 'duration' };
      case 10: return { kind: 'u128' };
      case 11: return { kind: 'i128' };
      case 12: return { kind: 'u256' };
      case 13: return { kind: 'i256' };
      case 14: return { kind: 'bytes' };
      case 15: return { kind: 'string' };
      case 16: return { kind: 'symbol' };
      case 17: return { kind: 'address' };
      case 1000: {
        const valueType = this.readTypeDef();
        return { kind: 'option', valueType };
      }
      case 1001: {
        const okType = this.readTypeDef();
        const errorType = this.readTypeDef();
        return { kind: 'result', okType, errorType };
      }
      case 1002: {
        const elementType = this.readTypeDef();
        return { kind: 'vec', elementType };
      }
      case 1003: {
        const keyType = this.readTypeDef();
        const valueType = this.readTypeDef();
        return { kind: 'map', keyType, valueType };
      }
      case 1004: {
        const count = this.readU32();
        const elementTypes: SorobanType[] = [];
        for (let i = 0; i < count; i++) elementTypes.push(this.readTypeDef());
        return { kind: 'tuple', elementTypes };
      }
      case 1005: {
        const n = this.readU32();
        return { kind: 'bytesN', n };
      }
      case 2000: {
        const name = this.readString();
        return { kind: 'udt', name };
      }
      default:
        throw new XdrDecodeError(`Unknown ScSpecType discriminant: ${kind}`);
    }
  }

  readSpecEntry(): SpecEntry {
    const kind = this.readU32();
    switch (kind) {
      case 0: { // FunctionV0
        const doc = this.readString();
        const name = this.readString();
        const inputCount = this.readU32();
        const inputs: SpecFunctionInput[] = [];
        for (let i = 0; i < inputCount; i++) {
          const inputDoc = this.readString();
          const inputName = this.readString();
          const type = this.readTypeDef();
          inputs.push({ name: inputName, doc: inputDoc || undefined, type });
        }
        const outputCount = this.readU32();
        const outputs: SorobanType[] = [];
        for (let i = 0; i < outputCount; i++) outputs.push(this.readTypeDef());
        return { kind: 'function', name, doc: doc || undefined, inputs, outputs };
      }
      case 1: { // StructV0
        const doc = this.readString();
        void this.readString(); // lib
        const name = this.readString();
        const fieldCount = this.readU32();
        const fields: StructField[] = [];
        for (let i = 0; i < fieldCount; i++) {
          const fieldDoc = this.readString();
          const fieldName = this.readString();
          const type = this.readTypeDef();
          fields.push({ name: fieldName, doc: fieldDoc || undefined, type });
        }
        return { kind: 'struct', name, doc: doc || undefined, fields };
      }
      case 2: { // UnionV0
        const doc = this.readString();
        void this.readString(); // lib
        const name = this.readString();
        const caseCount = this.readU32();
        const cases: UnionCase[] = [];
        for (let i = 0; i < caseCount; i++) {
          const caseDoc = this.readString();
          const caseName = this.readString();
          const typeCount = this.readU32();
          const types: SorobanType[] = [];
          for (let t = 0; t < typeCount; t++) types.push(this.readTypeDef());
          cases.push({ name: caseName, doc: caseDoc || undefined, types });
        }
        return { kind: 'union', name, doc: doc || undefined, cases };
      }
      case 3: { // EnumV0
        const doc = this.readString();
        void this.readString(); // lib
        const name = this.readString();
        const caseCount = this.readU32();
        const cases: EnumCase[] = [];
        for (let i = 0; i < caseCount; i++) {
          const caseDoc = this.readString();
          const caseName = this.readString();
          const value = this.readU32();
          cases.push({ name: caseName, value, doc: caseDoc || undefined });
        }
        return { kind: 'enum', name, doc: doc || undefined, cases };
      }
      case 4: { // ErrorEnumV0
        const doc = this.readString();
        void this.readString(); // lib
        const name = this.readString();
        const caseCount = this.readU32();
        const cases: EnumCase[] = [];
        for (let i = 0; i < caseCount; i++) {
          const caseDoc = this.readString();
          const caseName = this.readString();
          const value = this.readU32();
          cases.push({ name: caseName, value, doc: caseDoc || undefined });
        }
        return { kind: 'enum', name, doc: doc || undefined, cases };
      }
      default:
        throw new XdrDecodeError(`Unknown spec entry discriminant: ${kind}`);
    }
  }

  finish(): void {
    if (this.offset !== this.buffer.length) {
      throw new XdrDecodeError(`Unexpected trailing bytes in ${this.label} payload`);
    }
  }
}

export function parseWasmContractSpec(wasmBuffer: Buffer): ContractSpecResult {
  const specSections = extractWasmCustomSection(wasmBuffer, 'contractspecv0');
  const envSections = extractWasmCustomSection(wasmBuffer, 'contractenvmetav0');

  if (specSections.length === 0) {
    throw new WasmParseError('WASM binary does not contain a "contractspecv0" custom section.');
  }

  let protocolVersion: number | undefined;
  if (envSections.length > 0) {
    // Best-effort: env meta encoding varies; must not block strict spec decoding.
    try {
      const reader = new XdrReader(envSections[0], 'env meta');
      const count = reader.readU32();
      for (let i = 0; i < count; i++) {
        const key = reader.readString();
        const valKind = reader.readU32();
        if ((key === 'rsver' || key === 'interface_version') && valKind === 5) {
          protocolVersion = reader.readU32();
          break;
        }
        if ((key === 'rsver' || key === 'interface_version') && valKind === 6) {
          reader.readU32();
          protocolVersion = reader.readU32();
          break;
        }
        break;
      }
    } catch {
      protocolVersion = undefined;
    }
  }

  const specEntries: SpecEntry[] = [];
  for (const sectionPayload of specSections) {
    const reader = new XdrReader(sectionPayload, 'spec');
    while (reader.hasMore) {
      specEntries.push(reader.readSpecEntry());
    }
    reader.finish();
  }

  return {
    envMeta: protocolVersion !== undefined ? { protocolVersion } : undefined,
    specEntries
  };
}
