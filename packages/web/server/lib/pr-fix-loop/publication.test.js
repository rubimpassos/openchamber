import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApprovalPublication } from './publication.js';

const head = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const snapshot = { state: 'open', headSha: head, branch: 'fix', headRepo: { id: 'fork', owner: 'contributor', repo: 'app' } };
const loop = { directory: '/repo', readContext: { repositoryId: 'local', bindingRevision: 2 } };
const endpoint = { displayUrl: 'https://github.com/contributor/app.git', fingerprint: 'fork-fingerprint' };
const exported = { result: commit, changedPaths: 1, changedBytes: 10, unmerged: { count: 0 }, nestedRepositories: { count: 0 } };
let directory;
let commands;
let pushes;
let binding;
let ancestor;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publication-'));
  commands = []; pushes = []; ancestor = true;
  binding = { repository: { repositoryId: 'local', configRevision: 'config', remotes: [{ name: 'fork', push: endpoint }] },
    revision: 2, binding: { remotes: [{ name: 'fork', readiness: 'ready', mode: 'managed' }] } };
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const make = () => createApprovalPublication({
  dataDir: directory,
  git: { output: async (_where, args) => { commands.push(args); return ''; }, run: async () => ({ code: ancestor ? 0 : 1 }) },
  gitServices: () => ({ readBinding: async () => binding, publish: async (...args) => { pushes.push(args); } }),
});

test('captures a checked object with an immutable host ref and exact fork authority', async () => {
  const service = make();
  const pending = await service.capture(loop, snapshot, exported);
  expect(pending.receipt).toMatchObject({ commit, repositoryId: 'local', destination: { ref: 'refs/heads/fix', expectedHead: head, headRepo: { id: 'fork' } } });
  const write = commands.find((args) => args.includes('update-ref'));
  expect(write.slice(-3)).toEqual([pending.receipt.localRef, commit, '0'.repeat(40)]);
  expect(write.some((arg) => arg.startsWith('core.hooksPath='))).toBe(true);
});

for (const [name, change] of [
  ['new remote head', (remote) => ({ ...remote, headSha: 'c'.repeat(40) })],
  ['different ref', (remote) => ({ ...remote, branch: 'other' })],
  ['upstream with the same branch', (remote) => ({ ...remote, headRepo: { id: 'upstream', owner: 'upstream', repo: 'app' } })],
  ['replacement repository with the same name', (remote) => ({ ...remote, headRepo: { ...remote.headRepo, id: 'replacement' } })],
]) {
  test(`refuses ${name} before publication`, async () => {
    const service = make(); const pending = await service.capture(loop, snapshot, exported);
    await expect(service.publish(loop, pending, change(snapshot))).rejects.toThrow();
    expect(pushes).toEqual([]);
  });
}

test('publishes only the receipt object with an exact expected-head lease', async () => {
  const service = make(); const pending = await service.capture(loop, snapshot, exported);
  await service.publish(loop, pending, snapshot);
  expect(pushes).toEqual([[{ ...pending.authority, directory: '/repo', operation: 'push', sourceRef: pending.receipt.localRef,
    destinationRef: 'refs/heads/fix', forceWithLease: { expectedRemoteSha: head } }, commit]]);
});

for (const invalid of [
  { ...exported, result: 'refs/heads/host' },
  { ...exported, unmerged: { count: 1 } },
  { ...exported, nestedRepositories: { count: 1 } },
]) {
  test('refuses a hostile or incomplete export before writing an approval ref', async () => {
    const service = make();
    await expect(service.capture(loop, snapshot, invalid)).rejects.toThrow();
    expect(commands).toEqual([]);
  });
}

test('refuses an unrelated exported history', async () => {
  ancestor = false; const service = make();
  await expect(service.capture(loop, snapshot, exported)).rejects.toThrow();
  expect(commands).toEqual([]);
});

test('refuses an upstream remote as a fork publication destination', async () => {
  binding.repository.remotes[0].push = { ...endpoint, displayUrl: 'https://github.com/upstream/app.git' };
  await expect(make().validate(loop, snapshot)).rejects.toThrow();
  expect(pushes).toEqual([]);
});

test('refuses a replaced local repository before exporting an approval receipt', async () => {
  binding.repository.repositoryId = 'replacement';
  await expect(make().capture(loop, snapshot, exported)).rejects.toThrow();
  expect(commands).toEqual([]);
});

test('refuses changed binding authority before another worker iteration', async () => {
  binding.revision += 1;
  await expect(make().validate(loop, snapshot)).rejects.toThrow();
  expect(commands).toEqual([]);
});
