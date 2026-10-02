import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNetworkPolicy, isPersonalMachine } from '../src/network-policy.js';

test('treats desktops, WSL, and graphical sessions as personal machines and a bare Linux server as remote', () => {
  const noProc = () => { throw new Error('missing'); };
  assert.equal(isPersonalMachine({ platform: 'win32', env: {}, readFile: noProc }), true);
  assert.equal(isPersonalMachine({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, readFile: noProc }), true);
  assert.equal(isPersonalMachine({ platform: 'linux', env: {}, readFile: () => 'Linux version 6.6 microsoft-standard-WSL2' }), true);
  assert.equal(isPersonalMachine({ platform: 'linux', env: { DISPLAY: ':0' }, readFile: noProc }), true);
  assert.equal(isPersonalMachine({ platform: 'linux', env: {}, readFile: () => 'Linux version 6.8 generic' }), false);
});

test('lets the Settings choice win over config.json, which wins over where it runs, and keeps it across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'network-policy-'));
  const file = path.join(dir, 'network.json');
  try {
    const remote = createNetworkPolicy({ file, configured: null, personalMachine: false });
    assert.deepEqual(remote.state(), { allowPrivateNetwork: false, source: 'default', defaultValue: false, personalMachine: false });
    assert.equal(createNetworkPolicy({ file, configured: true, personalMachine: false }).allowPrivateNetwork(), true);

    remote.set(true);
    const reopened = createNetworkPolicy({ file, configured: false, personalMachine: false });
    assert.equal(reopened.allowPrivateNetwork(), true);
    assert.equal(reopened.state().source, 'settings');

    reopened.set(null);
    assert.equal(fs.existsSync(file), false);
    assert.equal(reopened.allowPrivateNetwork(), false);
    assert.throws(() => reopened.set('yes'), /true, false, or null/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
