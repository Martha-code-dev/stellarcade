const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(backendRoot, '..');

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('Backend lint CI lockfile installs', () => {
  test('lint.yml installs backend dependencies from the committed lockfile', () => {
    const source = read('.github/workflows/lint.yml');

    expect(source).toContain('npm ci');
    expect(source).toContain('cache-dependency-path: backend/package-lock.json');
    // `pnpm install` is fine; a bare `npm install` is the drift this test
    // guards against.
    expect(source).not.toMatch(/\bnpm install\b/);
  });

  test('the committed backend lockfile exists and is a modern lockfile', () => {
    const lock = JSON.parse(read('backend/package-lock.json'));

    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(lock.packages['']).toBeDefined();
  });

  test('package.json dependencies are present in the committed lockfile', () => {
    const pkg = JSON.parse(read('backend/package.json'));
    const lock = JSON.parse(read('backend/package-lock.json'));
    const locked = lock.packages[''];

    for (const section of ['dependencies', 'devDependencies']) {
      const declared = Object.keys(pkg[section] || {}).sort();
      const recorded = Object.keys(locked[section] || {}).sort();
      expect(recorded).toEqual(declared);
    }
  });
});
