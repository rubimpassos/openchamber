import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import { guestGrantScope, effectiveGrants } from './grant-scope.js';
import { invalidateGuestCatalog } from './catalog.js';
import { extensionsPersistPath } from './persist.js';
import { createPlanDirectoryAuthorizer, hashPlanBytes, listGuestPlans, readGuestPlan, writeGuestPlan } from './plans.js';
import { registerGuestRoutes } from './routes.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const tempRoot = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-plans-')));
  roots.push(root);
  return root;
};

const provider = {
  id: 'shelf',
  label: 'Shelf',
  root: '.shelf/plans',
  actions: [{ id: 'run', kind: 'execute', label: 'Run', run: { type: 'command', name: 'shelf-run', arguments: '{plan.name}' } }],
};

const worktreeWithPlans = async (root, name = 'repo') => {
  const directory = path.join(root, name);
  await fs.mkdir(path.join(directory, '.shelf/plans/nested'), { recursive: true });
  await fs.writeFile(path.join(directory, '.shelf/plans/auth.md'), '# Auth\n\n- [ ] one\n');
  await fs.writeFile(path.join(directory, '.shelf/plans/nested/billing.md'), '# Billing\n');
  await fs.writeFile(path.join(directory, '.shelf/plans/notes.txt'), 'not a plan');
  return directory;
};

describe('plan files', () => {
  test('lists every matching file under the root, never-run ones included, and nothing else', async () => {
    const root = await tempRoot();
    const directory = await worktreeWithPlans(root);
    const listed = await listGuestPlans({ provider, directory });
    expect(listed.ok && listed.result.plans.map((plan) => plan.path)).toEqual(['.shelf/plans/auth.md', '.shelf/plans/nested/billing.md']);
    expect(listed.ok && listed.result.truncated).toBe(false);
    // A provider whose folder does not exist yet has no plans: an authoritative empty list.
    expect(await listGuestPlans({ provider: { ...provider, root: '.other' }, directory })).toEqual({ ok: true, result: { plans: [], truncated: false } });
  });

  test('two worktrees with the same plan name read their own file', async () => {
    const root = await tempRoot();
    const first = await worktreeWithPlans(root, 'one');
    const second = await worktreeWithPlans(root, 'two');
    await fs.writeFile(path.join(second, '.shelf/plans/auth.md'), '# Auth in two\n');
    const a = await readGuestPlan({ provider, directory: first, path: '.shelf/plans/auth.md' });
    const b = await readGuestPlan({ provider, directory: second, path: '.shelf/plans/auth.md' });
    expect(a.ok && a.result.content).toBe('# Auth\n\n- [ ] one\n');
    expect(b.ok && b.result.content).toBe('# Auth in two\n');
  });

  test('refuses traversal, foreign paths and symlinks that leave the root or the worktree', async () => {
    const root = await tempRoot();
    const directory = await worktreeWithPlans(root);
    await fs.writeFile(path.join(root, 'secret.md'), 'secret');
    await fs.symlink(path.join(root, 'secret.md'), path.join(directory, '.shelf/plans/escape.md'));
    await fs.writeFile(path.join(directory, 'inside.md'), 'worktree file outside the root');
    await fs.symlink(path.join(directory, 'inside.md'), path.join(directory, '.shelf/plans/sideways.md'));
    for (const bad of ['.shelf/plans/../../secret.md', '/etc/passwd.md', '.shelf/plans/escape.md', '.shelf/plans/sideways.md', 'README.md', '.shelf/plans/notes.txt']) {
      const result = await readGuestPlan({ provider, directory, path: bad });
      expect(result).toMatchObject({ ok: false, code: 'BAD_PATH' });
    }
    const listed = await listGuestPlans({ provider, directory });
    expect(listed.ok && listed.result.plans.map((plan) => plan.path)).not.toContain('.shelf/plans/escape.md');

    const outside = path.join(root, 'outside-plans');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'x.md'), 'x');
    const linked = path.join(root, 'linked');
    await fs.mkdir(path.join(linked, '.shelf'), { recursive: true });
    await fs.symlink(outside, path.join(linked, '.shelf/plans'));
    expect(await listGuestPlans({ provider, directory: linked })).toMatchObject({ ok: false, code: 'BAD_PATH' });
    expect(await readGuestPlan({ provider, directory: linked, path: '.shelf/plans/x.md' })).toMatchObject({ ok: false, code: 'BAD_PATH' });
  });

  test('missing and non-UTF-8 plans fail with their own codes', async () => {
    const root = await tempRoot();
    const directory = await worktreeWithPlans(root);
    expect(await readGuestPlan({ provider, directory, path: '.shelf/plans/gone.md' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    await fs.writeFile(path.join(directory, '.shelf/plans/binary.md'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    expect(await readGuestPlan({ provider, directory, path: '.shelf/plans/binary.md' })).toMatchObject({ ok: false, code: 'HOST_REJECTED' });
  });

  test('a write replaces only the text it was based on, keeps the mode and the symlink, and never creates a plan', async () => {
    const root = await tempRoot();
    const directory = await worktreeWithPlans(root);
    const file = path.join(directory, '.shelf/plans/auth.md');
    await fs.chmod(file, 0o640);
    const read = await readGuestPlan({ provider, directory, path: '.shelf/plans/auth.md' });
    if (!read.ok) throw new Error(read.code);
    const written = await writeGuestPlan({ provider, directory, path: '.shelf/plans/auth.md', content: '# Auth\n\n- [x] one\n', expectedHash: read.result.hash });
    expect(written).toMatchObject({ ok: true, result: { hash: hashPlanBytes(Buffer.from('# Auth\n\n- [x] one\n')) } });
    expect(await fs.readFile(file, 'utf8')).toBe('# Auth\n\n- [x] one\n');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);

    // Someone else wrote meanwhile: the stale hash is refused with the current one.
    await fs.writeFile(file, '# Auth edited elsewhere\n');
    const stale = await writeGuestPlan({ provider, directory, path: '.shelf/plans/auth.md', content: 'mine', expectedHash: read.result.hash });
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', hash: hashPlanBytes(Buffer.from('# Auth edited elsewhere\n')) });
    expect(await fs.readFile(file, 'utf8')).toBe('# Auth edited elsewhere\n');

    expect(await writeGuestPlan({ provider, directory, path: '.shelf/plans/new.md', content: 'x', expectedHash: 'a'.repeat(64) }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await fs.readdir(path.join(directory, '.shelf/plans'))).not.toContain('new.md');

    await fs.symlink('auth.md', path.join(directory, '.shelf/plans/alias.md'));
    const alias = await readGuestPlan({ provider, directory, path: '.shelf/plans/alias.md' });
    if (!alias.ok) throw new Error(alias.code);
    await writeGuestPlan({ provider, directory, path: '.shelf/plans/alias.md', content: 'through alias', expectedHash: alias.result.hash });
    expect((await fs.lstat(path.join(directory, '.shelf/plans/alias.md'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('through alias');
    expect((await fs.readdir(path.join(directory, '.shelf/plans'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('two concurrent writes from the same text: one lands, the other conflicts', async () => {
    const root = await tempRoot();
    const directory = await worktreeWithPlans(root);
    const read = await readGuestPlan({ provider, directory, path: '.shelf/plans/auth.md' });
    if (!read.ok) throw new Error(read.code);
    const results = await Promise.all(['first', 'second'].map((content) => (
      writeGuestPlan({ provider, directory, path: '.shelf/plans/auth.md', content, expectedHash: read.result.hash })
    )));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === 'CONFLICT')).toHaveLength(1);
  });

  test('only registered projects and their worktrees are plan directories', async () => {
    const root = await tempRoot();
    const project = await worktreeWithPlans(root, 'project');
    const worktree = await worktreeWithPlans(root, 'project-wt');
    const stranger = await worktreeWithPlans(root, 'stranger');
    const allowed = createPlanDirectoryAuthorizer({
      listProjectPaths: async () => [project],
      listWorktreePaths: async (directory) => (directory === stranger ? [stranger] : [project, worktree]),
    });
    expect(await allowed(project)).toBe(true);
    expect(await allowed(worktree)).toBe(true);
    expect(await allowed(stranger)).toBe(false);
    expect(await allowed(path.join(root, 'missing'))).toBe(false);
  });
});

describe('plan routes', () => {
  const install = async ({ allowDirectory = true } = {}) => {
    const root = await tempRoot();
    const packageRoot = path.join(root, 'package');
    await fs.mkdir(packageRoot);
    await fs.writeFile(path.join(packageRoot, 'index.html'), '<script src="main.js"></script>');
    await fs.writeFile(path.join(packageRoot, 'main.js'), 'void 0;');
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'plan-shelf', version: '1.0.0', openchamber: {
      apiVersion: 1,
      contributes: { panel: { id: 'plan-shelf', name: 'Plan Shelf', icon: 'file-list' }, background: { entry: 'index.html' }, plans: [provider] },
    } }));
    const directory = await worktreeWithPlans(root);
    const app = express();
    registerGuestRoutes(app, {
      openchamberDataDir: path.join(root, 'data'),
      resolveGitBinaryForSpawn: () => 'git',
      resolveOptionalProjectDirectory: async (req) => ({ directory: req.get('x-opencode-directory') ?? null, error: null }),
      isPlanDirectoryAllowed: async (candidate) => allowDirectory && candidate === directory,
    });
    await request(app).post('/api/guests').send({ path: packageRoot }).expect(201);
    return { app, root, directory, persistPath: extensionsPersistPath(path.join(root, 'data')) };
  };

  test('the catalog carries the providers and approval covers exactly them', async () => {
    const { app, persistPath } = await install();
    const listed = await request(app).get('/api/guests').expect(200);
    expect(listed.body.guests[0]).toMatchObject({ plans: [provider], capabilities: { requested: ['plans'], granted: [] } });
    const stored = guestGrantScope({ plans: [provider] });
    expect(effectiveGrants(['plans'], stored, guestGrantScope({ plans: [{ ...provider, root: '.elsewhere' }] }))).toEqual([]);
    expect(effectiveGrants(['plans'], stored, guestGrantScope({ plans: [provider] }))).toEqual(['plans']);
    invalidateGuestCatalog(persistPath);
  });

  test('refuses before approval, when paused, for an undeclared provider and for an unregistered folder', async () => {
    const { app, directory, root } = await install();
    const list = (body, dir = directory) => request(app).post('/api/guests/plan-shelf/plans/list').set('x-opencode-directory', dir).send(body);
    expect((await list({ provider: 'shelf' })).body).toMatchObject({ error: 'NOT_GRANTED' });
    await request(app).put('/api/guests/plan-shelf/capabilities').send({ granted: ['plans'] }).expect(200);
    const ok = await list({ provider: 'shelf' });
    expect(ok.body).toMatchObject({ ok: true });
    expect(ok.body.result.plans.map((plan) => plan.path)).toEqual(['.shelf/plans/auth.md', '.shelf/plans/nested/billing.md']);
    expect((await list({ provider: 'other' })).status).toBe(404);
    expect((await list({ provider: 'shelf' }, root)).body).toMatchObject({ error: 'BAD_PATH' });
    expect((await request(app).post('/api/guests/plan-shelf/plans/list').send({ provider: 'shelf' })).body).toMatchObject({ error: 'NO_DIRECTORY' });

    const read = await request(app).post('/api/guests/plan-shelf/plans/file').set('x-opencode-directory', directory)
      .send({ op: 'read', provider: 'shelf', path: '.shelf/plans/auth.md' }).expect(200);
    const conflict = await request(app).post('/api/guests/plan-shelf/plans/file').set('x-opencode-directory', directory)
      .send({ op: 'write', provider: 'shelf', path: '.shelf/plans/auth.md', content: 'x', expectedHash: 'a'.repeat(64) });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: 'CONFLICT', message: 'The plan changed since it was opened.', hash: read.body.result.hash });
    const traversal = await request(app).post('/api/guests/plan-shelf/plans/file').set('x-opencode-directory', directory)
      .send({ op: 'read', provider: 'shelf', path: '.shelf/plans/../../../etc/passwd.md' });
    expect(traversal.body).toMatchObject({ error: 'BAD_PATH' });

    await request(app).put('/api/guests/plan-shelf/enabled').send({ enabled: false }).expect(200);
    expect((await list({ provider: 'shelf' })).body).toMatchObject({ error: 'DISABLED' });
  });
});
