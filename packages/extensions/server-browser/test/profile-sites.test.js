import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectCdp } from '../src/cdp-client.js';
import { createChromeProcess, resolveChromePath } from '../src/chrome-process.js';
import { createProfileStore } from '../src/profile-store.js';
import { clearProfileSite, listProfileSites } from '../src/profile-sites.js';

let chromePath = null;
try {
  chromePath = resolveChromePath();
} catch {}

const scratch = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-sites-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const profileHandleFor = (store, id) => ({
  checkout: () => store.checkout(id),
  checkin: (directory, version) => store.checkin(id, directory, version),
});

// Seeds cookies directly through CDP on a fresh checkout, bypassing navigation:
// this module's own job is listing/clearing what is already saved, not setting
// it. `Storage.setCookies` is a browser-level command (no attached target
// needed), matching the `Storage.getCookies` this module reads with.
const seedCookies = async (profile, cookies) => {
  const { directory, version } = await profile.checkout();
  const chrome = createChromeProcess({ chromePath, userDataDir: directory });
  try {
    const running = await chrome.ensure();
    const cdp = await connectCdp(running.endpoint);
    try {
      await cdp.send('Storage.setCookies', { cookies });
    } finally {
      cdp.close();
    }
  } finally {
    await chrome.close();
  }
  try {
    return await profile.checkin(directory, version);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

test('lists a saved profile\'s sites by cookie domain and clears one of them', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  // Given a saved profile with cookies on two domains.
  const directory = scratch(context);
  const store = createProfileStore({
    root: path.join(directory, 'store'),
    keyFile: path.join(directory, 'key', 'profile.key'),
    workRoot: path.join(directory, 'run'),
  });
  const saved = await store.create('Work');
  const profile = profileHandleFor(store, saved.id);
  // `expires` makes these persistent cookies; a session cookie (the default)
  // is discarded on the graceful close `checkin` relies on to flush them.
  const expires = Math.floor(Date.now() / 1_000) + 86_400;
  await seedCookies(profile, [
    { name: 'token', value: 'a', domain: '127.0.0.1', path: '/', expires },
    { name: 'token', value: 'b', domain: 'sub.example.test', path: '/', expires },
    { name: 'other', value: 'c', domain: 'sub.example.test', path: '/', expires },
  ]);

  // When the sites are listed, then both domains show up with their cookie counts, discarding the read-only copy.
  const sites = await listProfileSites(profile, { chromePath });
  assert.deepEqual(sites, [
    { domain: '127.0.0.1', cookies: 1 },
    { domain: 'sub.example.test', cookies: 2 },
  ]);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'run')), []);

  // When one site is cleared, then only its cookies are gone and the profile moves to a new version.
  const cleared = await clearProfileSite(profile, 'sub.example.test', { chromePath });
  assert.equal(cleared.version, 2);
  assert.deepEqual(cleared.sites, [{ domain: '127.0.0.1', cookies: 1 }]);
  assert.deepEqual(await listProfileSites(profile, { chromePath }), [{ domain: '127.0.0.1', cookies: 1 }]);
});

test('clearing a site with no matching cookies still checks in a new version', { skip: chromePath ? false : 'Chrome is unavailable' }, async (context) => {
  const directory = scratch(context);
  const store = createProfileStore({
    root: path.join(directory, 'store'),
    keyFile: path.join(directory, 'key', 'profile.key'),
    workRoot: path.join(directory, 'run'),
  });
  const saved = await store.create('Work');
  const profile = profileHandleFor(store, saved.id);
  const expires = Math.floor(Date.now() / 1_000) + 86_400;
  await seedCookies(profile, [{ name: 'token', value: 'a', domain: '127.0.0.1', path: '/', expires }]);

  const cleared = await clearProfileSite(profile, 'never-set.test', { chromePath });
  assert.equal(cleared.version, 2);
  assert.deepEqual(cleared.sites, [{ domain: '127.0.0.1', cookies: 1 }]);
});

test('refuses an empty domain before touching the profile', async () => {
  const profile = { checkout: async () => { throw new Error('must not check out'); }, checkin: async () => 1 };
  await assert.rejects(clearProfileSite(profile, ''), /domain is required/);
  await assert.rejects(clearProfileSite(profile, '   '), /domain is required/);
});
