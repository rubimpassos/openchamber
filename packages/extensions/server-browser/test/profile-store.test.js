import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProfileStore, defaultStorePaths } from '../src/profile-store.js';

const scratch = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-store-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const storeIn = (directory, overrides = {}) => createProfileStore({
  root: path.join(directory, 'data', 'openchamber-server-browser'),
  keyFile: path.join(directory, 'config', 'openchamber-server-browser', 'profile.key'),
  workRoot: path.join(directory, 'run'),
  ...overrides,
});

const writeProfileFiles = (directory) => {
  fs.mkdirSync(path.join(directory, 'Default', 'Network'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'Default', 'Cache', 'Cache_Data'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'Default', 'Network', 'Cookies'), 'SQLite format 3\0session=secret-cookie-value');
  fs.writeFileSync(path.join(directory, 'Default', 'Cache', 'Cache_Data', 'data_0'), 'cached bytes');
  fs.writeFileSync(path.join(directory, 'Local State'), '{"profile":{}}');
  fs.symlinkSync('host-1234', path.join(directory, 'SingletonLock'));
};

test('keeps data under XDG_DATA_HOME and the key under XDG_CONFIG_HOME', () => {
  const paths = defaultStorePaths({ HOME: '/home/u', XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/config' });
  assert.deepEqual(paths, {
    root: '/data/openchamber-server-browser',
    keyFile: '/config/openchamber-server-browser/profile.key',
  });
  assert.equal(defaultStorePaths({ HOME: '/home/u' }).root, '/home/u/.local/share/openchamber-server-browser');
});

test('refuses a key file inside the profile store', (context) => {
  const directory = scratch(context);
  assert.throws(
    () => createProfileStore({ root: path.join(directory, 'store'), keyFile: path.join(directory, 'store', 'profile.key') }),
    /outside the profile store/,
  );
});

test('creates, renames, binds, and resolves profiles by project directory', async (context) => {
  // Given two profiles, one bound to a project.
  const store = storeIn(scratch(context));
  const work = await store.create('  Work  ');
  const client = await store.create('Client X');
  await store.bind(work.id, '/srv/app/');

  // Then chats in the project or below it use the bound profile, others none.
  assert.deepEqual(await store.resolve('/srv/app'), { id: work.id, name: 'Work' });
  assert.deepEqual(await store.resolve('/srv/app/packages/web'), { id: work.id, name: 'Work' });
  assert.equal(await store.resolve('/srv/application'), null);
  assert.equal(await store.resolve('profile:whatever'), null);

  // When a nested directory is bound to another profile, then the nearest binding wins.
  await store.bind(client.id, '/srv/app/client');
  assert.equal((await store.resolve('/srv/app/client/x')).id, client.id);

  // When the same directory is bound again elsewhere, then it moves.
  await store.bind(client.id, '/srv/app');
  assert.deepEqual((await store.get(work.id)).projects, []);
  assert.deepEqual((await store.get(client.id)).projects, ['/srv/app', '/srv/app/client']);

  // Names stay unique regardless of case.
  await assert.rejects(store.create('work'), /already exists/);
  await assert.rejects(store.rename(client.id, 'WORK'), /already exists/);
  assert.equal((await store.rename(work.id, 'Personal')).name, 'Personal');
  await assert.rejects(store.bind(work.id, 'relative/path'), /absolute project directory/);
});

test('seals a profile encrypted with a key kept outside the store and restores it', async (context) => {
  const directory = scratch(context);
  const store = storeIn(directory);
  const profile = await store.create('Work');

  // Given a working copy with a cookie jar, a cache, and a lock of the Chrome that used it.
  const { directory: working, version } = await store.checkout(profile.id);
  assert.equal(fs.statSync(working).mode & 0o777, 0o700);
  writeProfileFiles(working);
  assert.equal(await store.checkin(profile.id, working, version), 1);
  fs.rmSync(working, { recursive: true, force: true });

  // Then the sealed file does not reveal its contents, and every path is private.
  const blob = fs.readFileSync(path.join(store.paths.blobDirectory, `${profile.id}.bin`));
  assert.equal(blob.includes(Buffer.from('secret-cookie-value')), false);
  assert.equal(blob.includes(Buffer.from('SQLite format')), false);
  assert.equal(fs.statSync(store.paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.paths.blobDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(store.paths.blobDirectory, `${profile.id}.bin`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.paths.registryFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.paths.keyFile).mode & 0o777, 0o600);
  assert.equal(path.dirname(store.paths.keyFile).startsWith(store.paths.root), false);

  // When it is checked out again, then the jar comes back without the cache or the stale lock.
  const { directory: restored } = await store.checkout(profile.id);
  assert.equal(fs.readFileSync(path.join(restored, 'Default', 'Network', 'Cookies'), 'utf8'), 'SQLite format 3\0session=secret-cookie-value');
  assert.equal(fs.existsSync(path.join(restored, 'Default', 'Cache')), false);
  assert.equal(fs.existsSync(path.join(restored, 'SingletonLock')), false);
  assert.ok((await store.get(profile.id)).lastUsedAt > 0);
  assert.equal((await store.get(profile.id)).saved, true);
});

test('a sealed profile cannot be opened under another id or with another key', async (context) => {
  const directory = scratch(context);
  const store = storeIn(directory);
  const first = await store.create('First');
  const second = await store.create('Second');
  const { directory: working, version } = await store.checkout(first.id);
  writeProfileFiles(working);
  await store.checkin(first.id, working, version);

  // Given one profile's file copied over another's.
  fs.copyFileSync(path.join(store.paths.blobDirectory, `${first.id}.bin`), path.join(store.paths.blobDirectory, `${second.id}.bin`));
  await assert.rejects(store.checkout(second.id), /could not be decrypted/);

  // Given a different key.
  fs.writeFileSync(store.paths.keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  await assert.rejects(store.checkout(first.id), /could not be decrypted/);

  // Given a key that other users can read.
  fs.chmodSync(store.paths.keyFile, 0o644);
  await assert.rejects(store.checkout(first.id), /readable by other users/);
});

test('revoking everything wipes profiles, registry, and key', async (context) => {
  const directory = scratch(context);
  const store = storeIn(directory);
  const profile = await store.create('Work');
  const { directory: working, version } = await store.checkout(profile.id);
  writeProfileFiles(working);
  await store.checkin(profile.id, working, version);

  await store.revokeAll();

  assert.deepEqual(await store.list(), []);
  assert.equal(fs.existsSync(store.paths.keyFile), false);
  assert.equal(fs.existsSync(store.paths.blobDirectory), false);
  // A browser that was still using the profile cannot bring it back.
  assert.equal(await store.checkin(profile.id, working, version + 1), null);
  assert.equal(fs.existsSync(store.paths.blobDirectory), false);
});

test('deleting a profile removes its sealed data', async (context) => {
  const store = storeIn(scratch(context));
  const profile = await store.create('Work');
  const { directory: working, version } = await store.checkout(profile.id);
  writeProfileFiles(working);
  await store.checkin(profile.id, working, version);

  await store.remove(profile.id);

  assert.equal(fs.existsSync(path.join(store.paths.blobDirectory, `${profile.id}.bin`)), false);
  await assert.rejects(store.get(profile.id), /no longer exists/);
});

test('refuses a copy taken before another save, and never lets it overwrite that save', async (context) => {
  // Given two copies of the same profile version.
  const store = storeIn(scratch(context));
  const profile = await store.create('Work');
  const first = await store.checkout(profile.id);
  const second = await store.checkout(profile.id);
  writeProfileFiles(first.directory);
  fs.writeFileSync(path.join(second.directory, 'Local State'), '{"second":true}');

  // When the first is saved, then the second, taken at the old version, is refused.
  assert.equal(await store.checkin(profile.id, first.directory, first.version), 1);
  await assert.rejects(store.checkin(profile.id, second.directory, second.version), (error) => error.code === 'STALE_PROFILE' && /Another chat saved/.test(error.message));

  // Then the saved profile is the first copy, and a new copy is at the new version.
  const fresh = await store.checkout(profile.id);
  assert.equal(fresh.version, 1);
  assert.equal(await store.version(profile.id), 1);
  assert.match(fs.readFileSync(path.join(fresh.directory, 'Default', 'Network', 'Cookies'), 'utf8'), /secret-cookie-value/);
});

test('removes copies a killed service left behind without saving them', async (context) => {
  const directory = scratch(context);
  const store = storeIn(directory);
  const profile = await store.create('Work');
  const { directory: working } = await store.checkout(profile.id);
  writeProfileFiles(working);

  assert.deepEqual(await storeIn(directory).removeStale(), [profile.id]);
  assert.equal(fs.existsSync(working), false);
  assert.equal((await store.get(profile.id)).saved, false);
});
