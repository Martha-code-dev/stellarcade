import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  parseWasmContractSpec,
  extractWasmCustomSection,
  WasmParseError,
  XdrDecodeError,
  ContractSpecResult,
} from './wasm-parser';
import { generateTypeScriptDefinitions, sorobanTypeToTs } from './ts-emitter';

function encodeLEB128U32(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function createWasmBuffer(customSections: Array<{ name: string; payload: Buffer }>): Buffer {
  const magicAndVersion = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const parts: Buffer[] = [magicAndVersion];
  for (const section of customSections) {
    const nameBuf = Buffer.from(section.name, 'utf8');
    const content = Buffer.concat([encodeLEB128U32(nameBuf.length), nameBuf, section.payload]);
    parts.push(Buffer.from([0x00]));
    parts.push(encodeLEB128U32(content.length));
    parts.push(content);
  }
  return Buffer.concat(parts);
}

function createSpecOnlyWasm(specEntriesPayload?: Buffer): Buffer {
  if (!specEntriesPayload) {
    return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  }
  return createWasmBuffer([{ name: 'contractspecv0', payload: specEntriesPayload }]);
}

function xdrU32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function xdrString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  const len = xdrU32(bytes.length);
  const padLen = (4 - (bytes.length % 4)) % 4;
  return Buffer.concat([len, bytes, Buffer.alloc(padLen)]);
}

// ScSpecType discriminants used by parser
const T = {
  VAL: 0, BOOL: 1, VOID: 2, ERROR: 3, U32: 4, I32: 5, U64: 6, I64: 7,
  TIMEPOINT: 8, DURATION: 9, U128: 10, I128: 11, U256: 12, I256: 13,
  BYTES: 14, STRING: 15, SYMBOL: 16, ADDRESS: 17,
  OPTION: 1000, RESULT: 1001, VEC: 1002, MAP: 1003, TUPLE: 1004, BYTES_N: 1005, UDT: 2000,
};

function tPrimitive(k: number): Buffer { return xdrU32(k); }
function tOption(inner: Buffer): Buffer { return Buffer.concat([xdrU32(T.OPTION), inner]); }
function tVec(inner: Buffer): Buffer { return Buffer.concat([xdrU32(T.VEC), inner]); }
function tTuple(elements: Buffer[]): Buffer { return Buffer.concat([xdrU32(T.TUPLE), xdrU32(elements.length), ...elements]); }
function tMap(k: Buffer, v: Buffer): Buffer { return Buffer.concat([xdrU32(T.MAP), k, v]); }
function tResult(ok: Buffer, err: Buffer): Buffer { return Buffer.concat([xdrU32(T.RESULT), ok, err]); }
function tBytesN(n: number): Buffer { return Buffer.concat([xdrU32(T.BYTES_N), xdrU32(n)]); }
function tUdt(name: string): Buffer { return Buffer.concat([xdrU32(T.UDT), xdrString(name)]); }

function specFunction(name: string, doc: string, inputs: Array<{ name: string; doc: string; type: Buffer }>, outputs: Buffer[]): Buffer {
  return Buffer.concat([
    xdrU32(0), // FunctionV0
    xdrString(doc),
    xdrString(name),
    xdrU32(inputs.length),
    ...inputs.map((i) => Buffer.concat([xdrString(i.doc), xdrString(i.name), i.type])),
    xdrU32(outputs.length),
    ...outputs,
  ]);
}

function specStruct(name: string, doc: string, fields: Array<{ name: string; doc: string; type: Buffer }>): Buffer {
  return Buffer.concat([
    xdrU32(1),
    xdrString(doc),
    xdrString(''), // lib
    xdrString(name),
    xdrU32(fields.length),
    ...fields.map((f) => Buffer.concat([xdrString(f.doc), xdrString(f.name), f.type])),
  ]);
}

function specUnion(name: string, doc: string, cases: Array<{ name: string; doc: string; types: Buffer[] }>): Buffer {
  return Buffer.concat([
    xdrU32(2),
    xdrString(doc),
    xdrString(''),
    xdrString(name),
    xdrU32(cases.length),
    ...cases.map((c) => Buffer.concat([xdrString(c.doc), xdrString(c.name), xdrU32(c.types.length), ...c.types])),
  ]);
}

function specEnum(name: string, doc: string, cases: Array<{ name: string; doc: string; value: number }>): Buffer {
  return Buffer.concat([
    xdrU32(3),
    xdrString(doc),
    xdrString(''),
    xdrString(name),
    xdrU32(cases.length),
    ...cases.map((c) => Buffer.concat([xdrString(c.doc), xdrString(c.name), xdrU32(c.value)])),
  ]);
}

function specErrorEnum(name: string, doc: string, cases: Array<{ name: string; doc: string; value: number }>): Buffer {
  return Buffer.concat([
    xdrU32(4),
    xdrString(doc),
    xdrString(''),
    xdrString(name),
    xdrU32(cases.length),
    ...cases.map((c) => Buffer.concat([xdrString(c.doc), xdrString(c.name), xdrU32(c.value)])),
  ]);
}

function assertCompiles(tsCode: string): void {
  const result = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      strict: true,
    },
    reportDiagnostics: true,
  });
  const diagnostics = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    const msg = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n');
    throw new Error(`TypeScript compilation failed:\n${msg}\n\n--- emitted source ---\n${tsCode}`);
  }
}

describe('wasm-type-generator', () => {
  it('sorobanTypeToTs maps primitives correctly', () => {
    expect(sorobanTypeToTs({ kind: 'bool' })).toBe('boolean');
    expect(sorobanTypeToTs({ kind: 'u32' })).toBe('number');
    expect(sorobanTypeToTs({ kind: 'u64' })).toBe('bigint');
    expect(sorobanTypeToTs({ kind: 'string' })).toBe('string');
    expect(sorobanTypeToTs({ kind: 'address' })).toBe('string');
    expect(sorobanTypeToTs({ kind: 'bytes' })).toBe('Uint8Array');
    expect(sorobanTypeToTs({ kind: 'option', valueType: { kind: 'u32' } })).toBe('number | null');
    expect(sorobanTypeToTs({ kind: 'vec', elementType: { kind: 'string' } })).toBe('Array<string>');
  });

  it('throws error when contractspecv0 section is missing', () => {
    const emptyWasm = createSpecOnlyWasm();
    expect(() => parseWasmContractSpec(emptyWasm)).toThrow(
      'WASM binary does not contain a "contractspecv0" custom section.'
    );
  });

  it('generates TypeScript definitions from mock spec result', () => {
    const mockSpec: ContractSpecResult = {
      envMeta: { protocolVersion: 20 },
      specEntries: [
        {
          kind: 'enum',
          name: 'GameStatus',
          doc: 'Status of game',
          cases: [
            { name: 'Pending', value: 0 },
            { name: 'Completed', value: 1 },
          ],
        },
        {
          kind: 'struct',
          name: 'PlayerStats',
          doc: 'Player score info',
          fields: [
            { name: 'score', type: { kind: 'u64' } },
            { name: 'player', type: { kind: 'address' } },
          ],
        },
        {
          kind: 'function',
          name: 'play_game',
          doc: 'Initiates game play',
          inputs: [
            { name: 'amount', type: { kind: 'u64' } },
            { name: 'choice', type: { kind: 'u32' } },
          ],
          outputs: [{ kind: 'bool' }],
        },
      ],
    };

    const tsOutput = generateTypeScriptDefinitions(mockSpec);

    expect(tsOutput).toContain('export enum GameStatus {');
    expect(tsOutput).toContain('Pending = 0,');
    expect(tsOutput).toContain('export interface PlayerStats {');
    expect(tsOutput).toContain('score: bigint;');
    expect(tsOutput).toContain('player: string;');
    expect(tsOutput).toContain('export interface SorobanContractClient {');
    expect(tsOutput).toContain('play_game(amount: bigint, choice: number): Promise<boolean>;');
  });

  it('extracts custom sections from WASM binary', () => {
    const mockPayload = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    const wasmBuf = createSpecOnlyWasm(mockPayload);
    const customSecs = extractWasmCustomSection(wasmBuf, 'contractspecv0');
    expect(customSecs.length).toBe(1);
    expect(customSecs[0]).toEqual(mockPayload);
  });

  describe('XDR spec decoding (strict/complete)', () => {
    it('parses a compiled-contract-like spec covering supported types and multi-value union variants', () => {
      const fn = specFunction(
        'run',
        'runs',
        [
          { name: 'a', doc: '', type: tPrimitive(T.U32) },
          { name: 'b', doc: '', type: tPrimitive(T.I64) },
          { name: 'c', doc: '', type: tOption(tPrimitive(T.STRING)) },
          { name: 'd', doc: '', type: tVec(tPrimitive(T.BYTES)) },
          { name: 'e', doc: '', type: tTuple([tPrimitive(T.BOOL), tPrimitive(T.SYMBOL)]) },
          { name: 'f', doc: '', type: tMap(tPrimitive(T.ADDRESS), tPrimitive(T.U64)) },
          { name: 'g', doc: '', type: tResult(tPrimitive(T.U128), tPrimitive(T.ERROR)) },
          { name: 'h', doc: '', type: tBytesN(32) },
          { name: 'i', doc: '', type: tUdt('CustomThing') },
          { name: 'j', doc: '', type: tPrimitive(T.TIMEPOINT) },
          { name: 'k', doc: '', type: tPrimitive(T.DURATION) },
          { name: 'l', doc: '', type: tPrimitive(T.I128) },
          { name: 'm', doc: '', type: tPrimitive(T.U256) },
          { name: 'n', doc: '', type: tPrimitive(T.I256) },
        ],
        [tPrimitive(T.VOID)],
      );
      const st = specStruct('Thing', '', [{ name: 'x', doc: '', type: tPrimitive(T.U32) }]);
      const en = specEnum('Kind', '', [{ name: 'A', doc: '', value: 0 }, { name: 'B', doc: '', value: 7 }]);
      const errEn = specErrorEnum('Errs', '', [{ name: 'Nope', doc: '', value: 1 }]);
      const un = specUnion('Choice', '', [
        { name: 'None', doc: '', types: [] },
        { name: 'One', doc: '', types: [tPrimitive(T.U32)] },
        { name: 'Two', doc: '', types: [tPrimitive(T.U32), tPrimitive(T.STRING)] },
      ]);
      const payload = Buffer.concat([fn, st, en, errEn, un]);
      const spec = parseWasmContractSpec(createSpecOnlyWasm(payload));

      expect(spec.specEntries).toHaveLength(5);
      const parsedFn = spec.specEntries[0];
      expect(parsedFn.kind).toBe('function');
      if (parsedFn.kind === 'function') {
        expect(parsedFn.inputs.map((i) => i.type.kind)).toEqual([
          'u32', 'i64', 'option', 'vec', 'tuple', 'map', 'result', 'bytesN', 'udt', 'timepoint', 'duration', 'i128', 'u256', 'i256',
        ]);
      }
      const parsedUnion = spec.specEntries.find((e) => e.kind === 'union');
      expect(parsedUnion && parsedUnion.kind === 'union' ? parsedUnion.cases.map((c) => c.types.length) : []).toEqual([0, 1, 2]);
      const parsedErrorEnum = spec.specEntries.find((e) => e.kind === 'enum' && e.name === 'Errs');
      expect(parsedErrorEnum).toBeTruthy();
    });

    it('rejects unknown spec entry discriminant', () => {
      const payload = Buffer.concat([xdrU32(99), xdrString('')]);
      expect(() => parseWasmContractSpec(createSpecOnlyWasm(payload))).toThrow(XdrDecodeError);
    });

    it('rejects unknown type discriminant', () => {
      // function with one input whose type is unknown discriminant 9999
      const payload = specFunction('f', '', [{ name: 'x', doc: '', type: xdrU32(9999) }], []);
      expect(() => parseWasmContractSpec(createSpecOnlyWasm(payload))).toThrow(/Unknown ScSpecType/);
    });

    it('rejects truncated payload (EOF mid-read)', () => {
      const full = specFunction('f', '', [], []);
      const truncated = full.subarray(0, full.length - 2);
      expect(() => parseWasmContractSpec(createSpecOnlyWasm(truncated))).toThrow(XdrDecodeError);
    });

    it('rejects malformed string lengths extending past payload', () => {
      // doc string claims len 100 but buffer is tiny
      const payload = Buffer.concat([xdrU32(0), xdrU32(100), Buffer.from('abc')]);
      expect(() => parseWasmContractSpec(createSpecOnlyWasm(payload))).toThrow(XdrDecodeError);
    });

    it('rejects trailing/extra bytes that do not form a valid entry', () => {
      const full = specFunction('f', '', [], []);
      const withTrailing = Buffer.concat([full, xdrU32(0)]);
      // Extra bytes are interpreted as the start of another entry and rejected as malformed/truncated.
      expect(() => parseWasmContractSpec(createSpecOnlyWasm(withTrailing))).toThrow(XdrDecodeError);
    });
  });

  describe('WASM section parsing (malformed lengths)', () => {
    it('rejects bad magic bytes', () => {
      const bad = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
      expect(() => extractWasmCustomSection(bad, 'x')).toThrow(/bad magic/i);
    });

    it('rejects unsupported version', () => {
      const bad = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
      expect(() => extractWasmCustomSection(bad, 'x')).toThrow(/unsupported version/i);
    });

    it('rejects section extending beyond EOF', () => {
      const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const buf = Buffer.concat([header, Buffer.from([0x01, 0x0a, 0x00])]); // size 10 but only 1 byte payload
      expect(() => extractWasmCustomSection(buf, 'x')).toThrow(/section extends beyond EOF/i);
    });

    it('rejects truncated LEB128', () => {
      const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const buf = Buffer.concat([header, Buffer.from([0x01, 0x80])]);
      expect(() => extractWasmCustomSection(buf, 'x')).toThrow(WasmParseError);
    });

    it('rejects LEB128 with more than five bytes', () => {
      const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const buf = Buffer.concat([header, Buffer.from([0x01, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])]);
      expect(() => extractWasmCustomSection(buf, 'x')).toThrow(/more than 5 bytes/i);
    });

    it('rejects overflowing u32 LEB128', () => {
      const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const buf = Buffer.concat([header, Buffer.from([0x01, 0x80, 0x80, 0x80, 0x80, 0x10])]);
      expect(() => extractWasmCustomSection(buf, 'x')).toThrow(/overflow/i);
    });

    it('rejects custom section name extending beyond section', () => {
      const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const buf = Buffer.concat([header, Buffer.from([0x00, 0x02, 0x0a, 0x61])]);
      expect(() => extractWasmCustomSection(buf, 'x')).toThrow(/name extends beyond section|section extends beyond EOF/i);
    });

    it('rejects malformed trailing data after last section', () => {
      const valid = createSpecOnlyWasm(specFunction('f', '', [], []));
      // A trailing byte is interpreted as a new section header and must be rejected as malformed.
      const withTrailing = Buffer.concat([valid, Buffer.from([0x00])]);
      expect(() => extractWasmCustomSection(withTrailing, 'contractspecv0')).toThrow(WasmParseError);
    });
  });

  describe('TypeScript emission (escaping and adversarial identifiers)', () => {
    it('escapes reserved/invalid identifiers, quoted fields, and comment terminators and emits compilable TS', () => {
      const mockSpec: ContractSpecResult = {
        specEntries: [
          {
            kind: 'struct',
            name: 'class',
            doc: 'has */ terminator',
            fields: [
              { name: 'bad-field', doc: 'doc */ end', type: { kind: 'u32' } },
              { name: '9lives', type: { kind: 'string' } },
              { name: "weird'name", type: { kind: 'bool' } },
            ],
          },
          {
            kind: 'union',
            name: 'switch',
            doc: 'u */ u',
            cases: [
              { name: 'case', types: [] },
              { name: 'bad-tag', types: [{ kind: 'u32' }] },
              { name: "x'y", types: [{ kind: 'u32' }, { kind: 'string' }] },
            ],
          },
          {
            kind: 'enum',
            name: 'enum',
            doc: 'e */ e',
            cases: [
              { name: 'default', value: 0, doc: 'd */ d' },
              { name: 'not-valid', value: 1 },
            ],
          },
          {
            kind: 'function',
            name: 'function',
            doc: 'f */ f',
            inputs: [
              { name: 'class', type: { kind: 'u32' } },
              { name: 'class', type: { kind: 'u64' } },
              { name: 'bad-name', type: { kind: 'string' } },
            ],
            outputs: [{ kind: 'udt', name: 'class' }],
          },
        ],
      };

      const out = generateTypeScriptDefinitions(mockSpec);

      // comment terminators escaped
      expect(out).not.toContain('*/ end');
      expect(out).not.toContain('u */ u');
      expect(out).not.toContain('e */ e');
      expect(out).not.toContain('d */ d');
      expect(out).not.toContain('f */ f');
      expect(out).toContain('*\\/');

      // reserved/invalid identifiers handled
      expect(out).toContain('export interface class_');
      expect(out).toContain("export type switch_");
      expect(out).toContain('export enum enum_');
      expect(out).toContain("'bad-field': number;");
      expect(out).toContain("'9lives': string;");
      expect(out).toContain("'weird\\'name': boolean;");
      expect(out).toContain("tag: 'case'");
      expect(out).toContain("tag: 'bad-tag'");
      expect(out).toContain("'function'(");

      // emitted TypeScript compiles
      assertCompiles(out);
    });

    it('emits compilable output for normal identifiers', () => {
      const mockSpec: ContractSpecResult = {
        specEntries: [
          { kind: 'enum', name: 'E', cases: [{ name: 'A', value: 1 }] },
          { kind: 'struct', name: 'S', fields: [{ name: 'x', type: { kind: 'u32' } }] },
          { kind: 'union', name: 'U', cases: [{ name: 'V', types: [{ kind: 'u32' }] }, { name: 'N', types: [] }] },
          { kind: 'function', name: 'f', inputs: [], outputs: [] },
        ],
      };
      const out = generateTypeScriptDefinitions(mockSpec);
      assertCompiles(out);
    });
  });
});
