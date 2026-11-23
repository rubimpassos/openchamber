import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareHistory, listChangedFiles, readAtBase, readBases } from './check-changed-history.mjs';
import { checkFileSizes, checkRatchet } from './check-changed.mjs';

const ui = 'packages/ui/src';
const timerRule = 'openchamber(no-timers)';
const timers = (count) => Array.from({ length: count }, (_, index) => `setTimeout(() => console.log(${index}), 10);\n`).join('');
const source = (lines, prefix = 'value') => Array.from({ length: lines }, (_, index) => `export const ${prefix}${index} = ${index};\n`).join('');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'oc-gate-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, {
    cwd: root, env: { ...process.env, GIT_MASTER: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const put = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Gate Fixture', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  put('.gitignore', 'node_modules/\n');
  return { root, git, put, commit };
}

test('bases resolve once to verified commits, deduplicate aliases and retain the default fork merge-base', (t) => {
  const { root, git, put, commit } = fixture(t);
  put(`${ui}/a.ts`, source(1));
  const fork = commit();
  git('update-ref', 'refs/remotes/origin/main', fork);
  git('update-ref', 'refs/tags/accepted', fork);
  put(`${ui}/a.ts`, source(2));
  const incoming = commit();

  const resolved = readBases(['--base', 'accepted', '--base', incoming, '--base', fork], root);
  git('update-ref', 'refs/tags/accepted', incoming);

  assert.deepEqual(resolved, [fork, incoming]);
  assert.equal(readAtBase(resolved[0], `${ui}/a.ts`, root), source(1));
  assert.deepEqual(readBases([], root), [fork]);
  for (const argv of [['--base'], ['--base', '--ratchet-only'], ['--base', 'missing'], ['--base', `${fork}^{tree}`]]) {
    assert.throws(() => readBases(argv, root));
  }
});

test('the union includes files unchanged in either history, staged changes and untracked sources', (t) => {
  const { root, git, put, commit } = fixture(t);
  put(`${ui}/a.ts`, source(1));
  put(`${ui}/b.ts`, source(1));
  const fork = commit();
  put(`${ui}/a.ts`, source(2));
  put(`${ui}/b.ts`, source(2));
  const incoming = commit();
  put(`${ui}/a.ts`, source(1));
  git('add', '--all');
  put(`${ui}/untracked.ts`, source(1));

  const files = listChangedFiles([fork, incoming].map((base) => compareHistory(base, root)), root);

  assert.deepEqual(files.sort(), [`${ui}/a.ts`, `${ui}/b.ts`, `${ui}/untracked.ts`]);
});

for (const [label, count, expected] of [['inherited', 2, []], ['new net debt', 3, [{ rule: timerRule, base: 2, current: 3, files: [`${ui}/a.ts`] }]]]) {
  test(`same-file debt uses the maximum when checking ${label}`, (t) => {
    const { root, put, commit } = fixture(t);
    put(`${ui}/a.ts`, timers(1));
    const fork = commit();
    put(`${ui}/a.ts`, timers(2));
    const incoming = commit();
    put(`${ui}/a.ts`, timers(count));
    const histories = [fork, incoming].map((base) => compareHistory(base, root));

    const violations = checkRatchet(histories, listChangedFiles(histories, root), root);

    assert.deepEqual(violations, expected);
  });
}

test('independent inherited files combine without allowing a rule absent from both histories', (t) => {
  const { root, put, commit } = fixture(t);
  put(`${ui}/a.ts`, timers(1));
  put(`${ui}/b.ts`, 'export const b = 1;\n');
  const fork = commit();
  put(`${ui}/a.ts`, 'export const a = 1;\n');
  put(`${ui}/b.ts`, timers(1));
  const incoming = commit();
  put(`${ui}/a.ts`, timers(1));
  put(`${ui}/new.ts`, 'export const type = typeof 1;\n');
  const histories = [fork, incoming].map((base) => compareHistory(base, root));

  const violations = checkRatchet(histories, listChangedFiles(histories, root), root);

  assert.deepEqual(violations, [{ rule: 'anti-slop(no-runtime-typeof)', base: 0, current: 1, files: [`${ui}/new.ts`] }]);
});

test('a proven rename normalizes duplicate debt across differently named histories', (t) => {
  const { root, git, put, commit } = fixture(t);
  put(`${ui}/old.ts`, timers(2));
  const fork = commit();
  renameSync(path.join(root, ui, 'old.ts'), path.join(root, ui, 'renamed.ts'));
  const incoming = commit();
  put(`${ui}/renamed.ts`, timers(3));
  git('add', '--all');
  const histories = [fork, incoming].map((base) => compareHistory(base, root));

  const violations = checkRatchet(histories, listChangedFiles(histories, root), root);

  assert.deepEqual(violations, [{ rule: timerRule, base: 2, current: 3, files: [`${ui}/renamed.ts`] }]);
});

test('a moved body behind a rewritten entry spends its predecessor debt only once', (t) => {
  const { root, git, put, commit } = fixture(t);
  put(`${ui}/entry.ts`, source(100) + timers(1));
  const base = commit();
  put(`${ui}/entry.ts`, "export * from './body.js';\n");
  put(`${ui}/body.ts`, source(100) + timers(2));
  git('add', '--all');
  const history = compareHistory(base, root);

  const violations = checkRatchet([history], listChangedFiles([history], root), root);

  assert.equal(history.renames.get(`${ui}/body.ts`), `${ui}/entry.ts`);
  assert.deepEqual(violations, [{ rule: timerRule, base: 1, current: 2, files: [`${ui}/body.ts`] }]);
});

test('rename detection retains actual lineage even when the configured exhaustive budget is too small', (t) => {
  const { root, git, put, commit } = fixture(t);
  const old = 'packages/web/server/lib/old';
  const moved = 'packages/web/server/lib/moved';
  for (let index = 0; index < 6; index++) put(`${old}/module-${index}.js`, source(810, `module${index}value`));
  const base = commit();
  for (let index = 0; index < 6; index++) {
    rmSync(path.join(root, old, `module-${index}.js`));
    put(`${moved}/module-${index}.ts`, source(810, `module${index}value`) + 'export type Id = string;\n');
  }
  git('config', 'diff.renameLimit', '1');
  git('add', '--all');
  const history = compareHistory(base, root);

  const growth = checkFileSizes([history], listChangedFiles([history], root), root);

  assert.equal(history.renames.size, 6);
  assert.deepEqual(growth, []);
});

for (const [lines, expected] of [[850, []], [901, [`${ui}/large.ts`]]]) {
  test(`oversized growth is compared with every accepted predecessor at ${lines} lines`, (t) => {
    const { root, put, commit } = fixture(t);
    put(`${ui}/large.ts`, source(820));
    const fork = commit();
    put(`${ui}/large.ts`, source(900));
    const incoming = commit();
    put(`${ui}/large.ts`, source(lines));
    const histories = [fork, incoming].map((base) => compareHistory(base, root));

    const growth = checkFileSizes(histories, listChangedFiles(histories, root), root);

    assert.deepEqual(growth.map(({ file }) => file), expected);
  });
}

test('a retained implementation cannot lend its size allowance to a same-named copy', (t) => {
  const { root, git, put, commit } = fixture(t);
  put('packages/web/server/lib/old/service.js', source(810));
  const base = commit();
  put('packages/web/server/lib/new/service.ts', source(810));
  git('add', '--all');
  const history = compareHistory(base, root);

  const growth = checkFileSizes([history], listChangedFiles([history], root), root);

  assert.deepEqual(growth.map(({ file, baseLines }) => ({ file, baseLines })), [{ file: 'packages/web/server/lib/new/service.ts', baseLines: null }]);
});
