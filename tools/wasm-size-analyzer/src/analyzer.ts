import * as fs from 'fs';
import type { WasmSection, WasmAnalysisResult, AnalyzerConfig } from './types';

const SECTION_NAMES: Record<number, string> = {
  0: 'Custom',
  1: 'Type',
  2: 'Import',
  3: 'Function',
  4: 'Table',
  5: 'Memory',
  6: 'Global',
  7: 'Export',
  8: 'Start',
  9: 'Element',
  10: 'Code',
  11: 'Data',
  12: 'DataCount',
};

const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const MAX_WASM_SIZE = 65536;

export class WasmFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmFormatError';
  }
}

function readLEB128(buffer: Buffer, offset: number, limit: number = buffer.length): { value: number; bytesRead: number } {
  let value = 0;
  let bytesRead = 0;
  let shift = 0;

  while (offset + bytesRead < limit) {
    const byte = buffer[offset + bytesRead];
    bytesRead += 1;
    if (bytesRead > 5) {
      throw new WasmFormatError('Malformed LEB128: more than 5 bytes for u32');
    }
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (shift === 28 && (byte & 0x70) !== 0) {
        throw new WasmFormatError('Malformed LEB128: u32 overflow');
      }
      return { value: value >>> 0, bytesRead };
    }
    shift += 7;
  }

  throw new WasmFormatError('Malformed LEB128: truncated value');
}

export class WasmAnalyzer {
  private config: AnalyzerConfig;

  constructor(config: AnalyzerConfig) {
    this.config = config;
  }

  analyze(): WasmAnalysisResult {
    if (!fs.existsSync(this.config.wasmPath)) {
      throw new Error(`File not found: ${this.config.wasmPath}`);
    }

    const buffer = fs.readFileSync(this.config.wasmPath);

    if (buffer.length < 8) {
      throw new WasmFormatError('Invalid WASM file: file is too small to contain magic bytes and version');
    }

    const magic = buffer.subarray(0, 4);
    const version = buffer.readUInt32LE(4);

    if (!magic.equals(MAGIC)) {
      throw new WasmFormatError('Invalid WASM file: bad magic bytes');
    }

    if (version !== 1) {
      throw new WasmFormatError(`Invalid WASM file: unsupported version ${version}`);
    }

    const sections = this.parseSections(buffer);
    const customSections = sections.filter((s) => s.id === 0);
    const dataSegmentSize = this.getDataSegmentSize(sections);
    const totalSize = buffer.length;
    const isOverSizeLimit = this.checkOversized(totalSize);
    const warnings = this.generateWarnings(sections, totalSize, dataSegmentSize);
    const recommendations = this.generateRecommendations(totalSize, sections);

    return {
      filePath: this.config.wasmPath,
      totalSize,
      sections,
      customSections,
      dataSegmentSize,
      isOverSizeLimit,
      warnings,
      recommendations,
    };
  }

  parseSections(buffer: Buffer): WasmSection[] {
    const sections: WasmSection[] = [];
    let offset = 8;

    while (offset < buffer.length) {
      const sectionId = buffer[offset];
      offset++;

      const { value: sectionSize, bytesRead: sizeBytesRead } = readLEB128(buffer, offset, buffer.length);
      offset += sizeBytesRead;

      const startOffset = offset;
      const sectionEnd = startOffset + sectionSize;
      if (sectionEnd > buffer.length) {
        throw new WasmFormatError('Invalid WASM: section extends beyond EOF');
      }

      let name = SECTION_NAMES[sectionId] || `Unknown(${sectionId})`;

      if (sectionId === 0 && sectionSize > 0) {
        const nameInfo = readLEB128(buffer, offset, sectionEnd);
        offset += nameInfo.bytesRead;
        const nameLen = nameInfo.value;
        if (offset + nameLen > sectionEnd) {
          throw new WasmFormatError('Invalid WASM: custom section name extends beyond section');
        }
        name = buffer.subarray(offset, offset + nameLen).toString('utf-8');
      }

      offset = sectionEnd;
      sections.push({
        id: sectionId,
        name,
        size: sectionSize,
        startOffset,
      });
    }

    if (offset !== buffer.length) {
      throw new WasmFormatError('Invalid WASM: trailing data after last section');
    }

    return sections;
  }

  getDataSegmentSize(sections: WasmSection[]): number {
    const dataSection = sections.find((s) => s.id === 11);
    return dataSection ? dataSection.size : 0;
  }

  checkOversized(totalSize: number): boolean {
    return totalSize > MAX_WASM_SIZE;
  }

  generateWarnings(sections: WasmSection[], totalSize: number, dataSegmentSize: number): string[] {
    const warnings: string[] = [];

    if (totalSize > MAX_WASM_SIZE) {
      warnings.push(
        `WASM binary exceeds recommended size limit: ${(totalSize / 1024).toFixed(2)} KB > 64 KB`
      );
    }

    if (totalSize > 0 && dataSegmentSize > totalSize * 0.1) {
      warnings.push(
        `Large data segment: ${(dataSegmentSize / 1024).toFixed(2)} KB (${((dataSegmentSize / totalSize) * 100).toFixed(1)}% of total)`
      );
    }

    const largeCustomSections = sections.filter(
      (s) => s.id === 0 && s.size > totalSize * 0.1
    );
    for (const section of largeCustomSections) {
      warnings.push(
        `Large custom section "${section.name}": ${(section.size / 1024).toFixed(2)} KB (${((section.size / totalSize) * 100).toFixed(1)}% of total) - may contain debug symbols`
      );
    }

    return warnings;
  }

  generateRecommendations(totalSize: number, sections: WasmSection[]): string[] {
    const recommendations: string[] = [];

    if (totalSize > MAX_WASM_SIZE) {
      recommendations.push('Set opt-level = "z" in Cargo.toml for maximum size optimization');
      recommendations.push('Enable LTO (link-time optimization) in Cargo.toml');
    }

    const hasCustomSections = sections.some((s) => s.id === 0);
    if (hasCustomSections) {
      recommendations.push('Run `wasm-strip` or `wasm-opt --strip-debug` to remove debug symbols');
    }

    if (totalSize > MAX_WASM_SIZE * 0.5) {
      recommendations.push('Consider using `wasm-opt -Oz` for aggressive size optimization');
      recommendations.push('Review dependencies for unused code that can be eliminated');
    }

    return recommendations;
  }
}
