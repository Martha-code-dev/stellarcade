const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../..');

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const toolchain = read('rust-toolchain.toml');
const workflowFiles = [
  '.github/workflows/lint.yml',
  '.github/workflows/test-contracts.yml',
  '.github/workflows/contract-size.yml',
  '.github/workflows/excluded-crates-report.yml',
];

const listValue = (source, key) => {
  const match = source.match(new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!match) return null;
  return match[1]
    .split(',')
    .map((value) => value.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
};

describe('Rust toolchain pinning', () => {
  test('rust-toolchain.toml pins one explicit version instead of stable', () => {
    expect(toolchain).toMatch(/channel\s*=\s*"1\.91\.0"/);
    expect(toolchain).not.toMatch(/channel\s*=\s*"stable"/);
  });

  test('rust-toolchain.toml declares the components and targets CI relies on', () => {
    expect(listValue(toolchain, 'components')).toEqual(
      expect.arrayContaining(['clippy', 'rustfmt'])
    );
    expect(listValue(toolchain, 'targets')).toEqual(
      expect.arrayContaining(['wasm32-unknown-unknown', 'wasm32v1-none'])
    );
  });

  test.each(workflowFiles)('%s does not install a second toolchain version', (workflow) => {
    const source = read(workflow);

    // dtolnay/rust-toolchain@stable is the action ref, not a toolchain input.
    // A `toolchain:` key would override rust-toolchain.toml and reintroduce
    // the drift this issue fixes.
    expect(source).not.toMatch(/^\s+toolchain:\s/m);
  });

  test.each(workflowFiles)('%s prints the effective toolchain versions', (workflow) => {
    const source = read(workflow);

    expect(source).toContain('Print Rust toolchain versions');
    expect(source).toContain('rustc -Vv');
    expect(source).toContain('cargo -V');
    expect(source).toContain('rustup show active-toolchain');
  });
});
