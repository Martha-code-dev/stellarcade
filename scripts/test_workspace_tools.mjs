#!/usr/bin/env node
// Unit tests for scripts/workspace_tools.mjs.
// Run with: node --test scripts/test_workspace_tools.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverTools, readWorkspaceGlobs } from './workspace_tools.mjs';

function makeRoot(tools, { importers = tools.map((tool) => tool.dir) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tools-'));
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    ['packages:', '  - "apps/*"', '  - "tools/*"', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(root, 'pnpm-lock.yaml'),
    ['lockfileVersion: \'9.0\'', 'importers:', ...importers.map((dir) => `  ${dir}:`), ''].join('\n')
  );
  for (const tool of tools) {
    const dir = path.join(root, tool.dir);
    fs.mkdirSync(dir, { recursive: true });
    if (tool.pkg === null) continue;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(tool.pkg));
  }
  return root;
}

const tool = (dir, name, scripts = { build: 'tsc', test: 'vitest run' }) => ({
  dir,
  pkg: { name, scripts },
});

test('real workspace: every shipped tool is discovered exactly once', () => {
  const { tools, problems } = discoverTools();
  assert.deepEqual(problems, []);
  const names = tools.map((item) => item.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('@stellarcade/auth-signature-linter'));
  assert.ok(names.includes('@stellarcade/wasm-type-generator'));
  assert.equal(tools.length, 5);
});

test('real workspace: shell-only tools are reported as skipped with a reason', () => {
  const { skipped } = discoverTools();
  const cargoAudit = skipped.find((item) => item.dir === 'tools/cargo-audit-reporter');
  assert.ok(cargoAudit);
  assert.match(cargoAudit.reason, /no package.json/);
});

test('real workspace: pnpm-workspace.yaml declares the tools glob', () => {
  assert.ok(readWorkspaceGlobs().includes('tools/*'));
});

test('duplicate tool names are a manifest problem', () => {
  const root = makeRoot([
    tool('tools/one', '@stellarcade/dup'),
    tool('tools/two', '@stellarcade/dup'),
  ]);
  const { problems } = discoverTools(root);
  assert.ok(problems.some((p) => p.includes('duplicate tool name')));
});

test('a tool missing from the lockfile is a frozen-install problem', () => {
  const root = makeRoot([tool('tools/one', '@stellarcade/one')], { importers: [] });
  const { problems } = discoverTools(root);
  assert.ok(problems.some((p) => p.includes('missing pnpm-lock.yaml importer')));
});

test('a directory without package.json is skipped, not treated as supported', () => {
  const root = makeRoot([{ dir: 'tools/shell-only', pkg: null }]);
  const { tools, skipped, problems } = discoverTools(root);
  assert.deepEqual(
    problems.filter((p) => !p.includes('no supported tools')),
    []
  );
  assert.equal(tools.length, 0);
  assert.equal(skipped.length, 1);
});
