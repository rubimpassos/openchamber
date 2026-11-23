#!/usr/bin/env node
// The pre-commit gate for agent work: type-check, lint, dead code, a ratchet
// over the files the change touches, and a size limit on them.
//
// The ratcheted rules (`oxlint.anti-slop.config.ts`) have a backlog older than
// the rules, so a blanket oxlint run is never clean. The ratchet compares the changed files with their versions at the
// base and fails when a rule reports more findings across them than it did
// there: a change may leave old findings alone, but it cannot add new ones.
// Totals are per rule over the whole change, so code moved between files
// (ten private copies of a check folded into one shared helper) is not new.
//
// A file the change renamed is compared with its old path, and a file it
// deleted counts at the base, so splitting or moving a file is not new either.
//
// The size limit: a source file over 800 lines cannot be added and cannot grow.
//
// The default base is where the branch left origin/main. Repeat --base for
// explicitly accepted integration histories; duplicate file/rule debt uses
// their maximum, after normalizing proven renames to the current path.
//
// Usage: bun run check:changed [--base <ref> ...] [--ratchet-only]
// `--ratchet-only` skips workspace type-check, lint and dead code. Server
// TypeScript lint and declaration pairs still fail outright in that mode.

import { execFileSync, spawnSync } from 'node:child_process';
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareHistory, listChangedFiles, readAtBase, readBases } from './check-changed-history.mjs';
export { parseRenames } from './check-changed-history.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OXLINT_CONFIG = path.join(REPO_ROOT, 'oxlint.anti-slop.config.ts');
const SIZE_LIMIT = 800;
const SIZED_FILE = /^packages\/[^/]+\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SIZE_EXEMPT = /(\.(test|spec|vitest|fixture|test-support|bench)\.|\/(__tests__|tests?)\/|\/i18n\/messages\/|\.i18n\.ts$|\.d\.ts$|\.generated\.)/;

const countLines = (content) => (content === '' ? 0 : content.replace(/\n$/, '').split('\n').length);

const SERVER_SOURCE = /^packages\/web\/(server|bin)\/.*\.ts$/;
const SERVER_JAVASCRIPT = /^packages\/web\/(server|bin)\/.*\.js$/;

/**
 * A server file that was already over the limit as JavaScript and is now the
 * same file in TypeScript: the types it gained make it longer, and it stays in
 * the backlog of files to split. The file may have moved to another server
 * folder on the way, keeping its name.
 */
const isTypedConversion = ({ file, basePath, baseLines }) => (
  SERVER_SOURCE.test(file) && SERVER_JAVASCRIPT.test(basePath)
    && path.basename(basePath, '.js') === path.basename(file, '.ts') && baseLines > SIZE_LIMIT
);

/**
 * Source files over the size limit that the change added or made longer.
 * Message catalogs, declarations, generated files and tests have no limit.
 */
export const findOversizedGrowth = (sizes) => sizes.filter((size) => {
  const { file, currentLines } = size;
  return SIZED_FILE.test(file) && !SIZE_EXEMPT.test(file) && currentLines > SIZE_LIMIT
    && (size.predecessors ?? [size]).every((predecessor) => !isTypedConversion({ file, ...predecessor })
      && (predecessor.baseLines === null || currentLines > predecessor.baseLines));
});

export const checkFileSizes = (histories, files, root = REPO_ROOT) => findOversizedGrowth(files.map((file) => {
  const predecessors = histories.map(({ base, renames }) => {
    const basePath = renames.get(file) ?? file;
    const content = readAtBase(base, basePath, root);
    return { basePath, baseLines: content === null ? null : countLines(content) };
  });
  const sizes = predecessors.map(({ baseLines }) => baseLines).filter((lines) => lines !== null);
  return {
    file,
    predecessors,
    baseLines: sizes.length ? Math.max(...sizes) : null,
    currentLines: countLines(readFileSync(path.join(root, file), 'utf8')),
  };
}));

/** Findings counted per file and rule, keyed `file\0rule`. */
const countFindings = (diagnostics, toRepoPath) => {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    const key = `${toRepoPath(diagnostic.filename)}\0${diagnostic.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const totalsByRule = (counts) => {
  const totals = new Map();
  for (const [key, count] of counts) {
    const rule = key.split('\0')[1];
    totals.set(rule, (totals.get(rule) ?? 0) + count);
  }
  return totals;
};

/**
 * Every rule that reports more findings across the change than at the base,
 * with the files where it grew to show where to look.
 */
export const findRatchetViolations = (baseCounts, currentCounts) => {
  const baseTotals = totalsByRule(baseCounts);
  const violations = [];
  for (const [rule, current] of totalsByRule(currentCounts)) {
    const base = baseTotals.get(rule) ?? 0;
    if (current <= base) continue;
    const files = [];
    for (const [key, count] of currentCounts) {
      const [file, keyRule] = key.split('\0');
      if (keyRule === rule && count > (baseCounts.get(key) ?? 0)) files.push(file);
    }
    violations.push({ rule, base, current, files: files.sort() });
  }
  return violations.sort((left, right) => left.rule.localeCompare(right.rule));
};

/**
 * Findings from oxlint's JSON report. A change that touches only paths the
 * config ignores, such as generated example bundles, leaves oxlint with
 * nothing to lint: it prints "No files found to lint." instead of a report,
 * and that means no findings rather than a broken gate.
 */
export const parseOxlintReport = (stdout) => {
  const start = stdout.indexOf('{');
  if (start === -1) {
    if (stdout.includes('No files found to lint')) return [];
    throw new Error(`oxlint produced no report: ${stdout}`);
  }
  return JSON.parse(stdout.slice(start)).diagnostics;
};

const runOxlint = (files, cwd) => {
  if (files.length === 0) return [];
  const result = spawnSync('bunx', ['oxlint', '-c', OXLINT_CONFIG, '-f', 'json', ...files], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (!result.stdout) throw new Error(`oxlint produced no report: ${result.stderr}`);
  return parseOxlintReport(result.stdout);
};

const readBaseFindings = (history, files, root) => {
  const { base, renames, deleted } = history;
  const currentPaths = new Map([...renames].map(([to, from]) => [from, to]));
  const baseDir = mkdtempSync(path.join(tmpdir(), 'oc-check-changed-'));
  try {
    const baseFiles = [];
    for (const file of new Set([...files.map((changed) => renames.get(changed) ?? changed), ...deleted])) {
      const content = readAtBase(base, file, root);
      if (content === null) continue; // Added since the base: every finding in it is new.
      const target = path.join(baseDir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
      baseFiles.push(target);
    }
    return countFindings(runOxlint(baseFiles, baseDir), (file) => {
      const relative = path.relative(baseDir, path.resolve(baseDir, file));
      return currentPaths.get(relative) ?? relative;
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
};

export const checkRatchet = (histories, files, root = REPO_ROOT) => {
  const current = countFindings(runOxlint(files, root), (file) => path.relative(root, path.resolve(root, file)));
  const accepted = new Map();
  for (const history of histories) {
    for (const [key, count] of readBaseFindings(history, files, root)) {
      accepted.set(key, Math.max(accepted.get(key) ?? 0, count));
    }
  }
  return findRatchetViolations(accepted, current);
};

/**
 * Knip 5.80 applies gitignore patterns to absolute package-entry paths:
 * `*.local` then matches the .local ancestor of an OpenCode worktree.
 * Analyze an independent source snapshot so ignores stay inside the checkout.
 * A root symlink is insufficient: resolvers canonicalize it back to .local.
 */
export const withKnipSnapshot = (root, analyze) => {
  if (!path.resolve(root).split(path.sep).some((segment) => segment.startsWith('.'))) return analyze(root);
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, env: { ...process.env, GIT_MASTER: '1' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean))];
  const tempRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const temp = mkdtempSync(path.join(tempRoot, 'oc-check-dead-code-'));
  const snapshot = path.join(temp, 'repo');
  try {
    mkdirSync(snapshot);
    for (const file of files) {
      const source = path.join(root, file);
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) continue;
      const target = path.join(snapshot, file);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    }
    const packageDirs = new Set(['.', ...files.filter((file) => path.basename(file) === 'package.json').map((file) => path.dirname(file))]);
    for (const dir of packageDirs) {
      const modules = path.join(root, dir, 'node_modules');
      if (existsSync(modules)) {
        const target = path.join(snapshot, dir, 'node_modules');
        mkdirSync(path.dirname(target), { recursive: true });
        symlinkSync(modules, target, process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    return analyze(snapshot);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

const runStep = (label, command, args, cwd = REPO_ROOT) => {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  return result.status === 0;
};

const main = () => {
  const argv = process.argv.slice(2);
  const bases = readBases(argv);
  const ratchetOnly = argv.includes('--ratchet-only');
  const histories = bases.map((base) => compareHistory(base));
  const files = listChangedFiles(histories);
  console.log(`Bases ${bases.join(', ')}; ${files.length} changed source file(s).`);

  const failed = [];
  if (!ratchetOnly) {
    if (!runStep('type-check', 'bun', ['run', 'type-check'])) failed.push('type-check');
    if (!runStep('lint', 'bun', ['run', 'lint'])) failed.push('lint');
    if (!withKnipSnapshot(REPO_ROOT, (cwd) => runStep('dead code', 'bun', ['run', 'dead-code'], cwd))) failed.push('dead code');
  }
  if (ratchetOnly && !runStep('server TypeScript lint and declaration pairs', 'bun', ['run', '--cwd', 'packages/web', 'lint:server'])) {
    failed.push('server TypeScript lint and declaration pairs');
  }

  console.log('\n▶ ratchet');
  const violations = checkRatchet(histories, files);
  for (const { rule, base: before, current, files: grown } of violations) {
    console.log(`  ${rule}: ${before} → ${current} (grew in ${grown.join(', ')})`);
  }
  if (violations.length > 0) {
    console.log(`  Run \`bunx oxlint -c oxlint.anti-slop.config.ts <file>\` for locations and what to do instead. Fix the new findings; the old ones may stay.`);
    failed.push('ratchet');
  } else {
    console.log('  No new findings.');
  }

  console.log('\n▶ file size');
  const oversized = checkFileSizes(histories, files);
  for (const { file, baseLines, currentLines } of oversized) {
    console.log(`  ${file}: ${baseLines === null ? 'new file' : baseLines} → ${currentLines} lines (limit ${SIZE_LIMIT})`);
  }
  if (oversized.length > 0) {
    console.log('  Put the new behavior in its own module in the feature\'s folder and import it. Do not make room by deleting unrelated code.');
    failed.push('file size');
  } else {
    console.log('  No file over the limit grew.');
  }

  if (failed.length > 0) {
    console.log(`\n✗ Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('\n✓ All checks passed.');
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
