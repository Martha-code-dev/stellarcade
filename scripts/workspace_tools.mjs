#!/usr/bin/env node
// Discover the shipped pnpm workspace tools from pnpm-workspace.yaml.
//
// This is the single manifest used by the tools build/typecheck/test CI matrix.
// A tool is "supported" when it lives under a workspace glob, has a package.json
// with a name, and declares a `test` script. Directories without a package.json
// (for example the shell-only tools/cargo-audit-reporter) are intentionally
// reported in `skipped` rather than silently dropped.
//
// The script also proves frozen installs are safe: every discovered tool must
// already have an importer in pnpm-lock.yaml, otherwise `pnpm install
// --frozen-lockfile` would rewrite the lockfile in CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/** Read the `packages:` globs from pnpm-workspace.yaml without a YAML dependency. */
export function readWorkspaceGlobs(root = REPO_ROOT) {
  const text = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*(?:#.*)?$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;
    const match = line.match(/^\s+-\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/);
    if (match) globs.push(match[1]);
  }
  return globs;
}

/** Expand a workspace glob such as `tools/*` to immediate child directories. */
function expandGlob(root, glob) {
  if (!glob.endsWith('/*')) return [glob];
  const parent = glob.slice(0, -2);
  const parentDir = path.join(root, parent);
  if (!fs.existsSync(parentDir)) return [];
  return fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .sort();
}

/** Importer keys present in pnpm-lock.yaml (the dirs a frozen install expects). */
export function readLockfileImporters(root = REPO_ROOT) {
  const text = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  const importers = new Set();
  let inImporters = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      continue;
    }
    if (inImporters && /^\S/.test(line)) break;
    if (!inImporters) continue;
    const match = line.match(/^  ([^\s:][^:]*):\s*$/);
    if (match) importers.add(match[1]);
  }
  return importers;
}

/**
 * Discover supported tools and validate the manifest.
 * Returns { tools, skipped, problems }.
 */
export function discoverTools(root = REPO_ROOT) {
  const globs = readWorkspaceGlobs(root).filter((glob) => glob.startsWith('tools/'));
  const directories = [...new Set(globs.flatMap((glob) => expandGlob(root, glob)))].sort();
  const importers = readLockfileImporters(root);
  const tools = [];
  const skipped = [];
  const problems = [];
  const names = new Set();

  for (const dir of directories) {
    const pkgPath = path.join(root, dir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      skipped.push({ dir, reason: 'no package.json (not a Node workspace tool)' });
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (error) {
      problems.push(`${dir}: unreadable package.json (${error.message})`);
      continue;
    }
    if (!pkg.name) {
      skipped.push({ dir, reason: 'package.json has no name' });
      continue;
    }
    if (!pkg.scripts || !pkg.scripts.test) {
      skipped.push({ dir, reason: 'no test script' });
      continue;
    }
    if (names.has(pkg.name)) {
      problems.push(`${dir}: duplicate tool name ${pkg.name}`);
    }
    names.add(pkg.name);

    if (!importers.has(dir)) {
      problems.push(`${dir}: missing pnpm-lock.yaml importer (frozen install would rewrite it)`);
    }

    tools.push({
      dir,
      name: pkg.name,
      hasBuild: Boolean(pkg.scripts.build),
      hasTypecheck: Boolean(pkg.scripts.typecheck),
    });
  }

  if (tools.length === 0) problems.push('no supported tools discovered under tools/*');
  return { tools, skipped, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { tools, skipped, problems } = discoverTools();
  if (problems.length) {
    for (const problem of problems) console.error(`ERROR: ${problem}`);
    process.exit(1);
  }
  for (const item of skipped) {
    console.error(`SKIP ${item.dir}: ${item.reason}`);
  }
  for (const tool of tools) {
    console.error(`TOOL ${tool.dir} -> ${tool.name}`);
  }
  console.log(JSON.stringify(tools));
}
