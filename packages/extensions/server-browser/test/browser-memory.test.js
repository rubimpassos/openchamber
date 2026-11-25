import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { readBrowserMemory } from '../src/browser-memory.js';
import { createBrowserManager } from '../src/browser-manager.js';

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === '@openchamber/sdk'
      ? new URL('../../../sdk/src/index.ts', import.meta.url).href : specifier, context);
  },
});
const { createService } = await import('../src/service.js');
const child = (pid) => ({ pid, exitCode: null, signalCode: null });
const table = '10 1 S\n11 10 S\n12 11 S\n20 1 S\n21 20 S\n99 1 S\n';
const files = {
  async readFile(file) {
    const pid = Number(file.split('/')[2]);
    const pss = new Map([[10, 100], [11, 20], [12, 30], [20, 200], [21, 40], [99, 900]]).get(pid);
    assert.notEqual(pss, undefined, 'only owning descendants are read');
    return `Rss: 9999 kB\nPss: ${pss} kB\n`;
  },
};

test('sums only the owning browser and its descendants from one Linux snapshot', async () => {
  let reads = 0;
  const memory = await readBrowserMemory([child(10), child(20), child(999)], {
    platform: 'linux', files, readProcessTable: async () => { reads += 1; return table; },
  });
  assert.deepEqual(memory, [150 * 1024, 240 * 1024, null]);
  assert.equal(reads, 1);
});

test('reports unavailable memory without invoking Linux tools on unsupported platforms or stopped browsers', async () => {
  for (const [platform, processes] of [
    ['darwin', [child(10)]], ['win32', [child(10)]],
    ['linux', [null, { ...child(10), exitCode: 1 }, { ...child(20), signalCode: 'SIGKILL' }]],
  ]) {
    let reads = 0;
    assert.deepEqual(await readBrowserMemory(processes, {
      platform, files, readProcessTable: async () => { reads += 1; return table; },
    }), processes.map(() => null));
    assert.equal(reads, 0);
  }
});

test('never substitutes zero or partial data for failed or invalid process snapshots', async () => {
  for (const output of ['', '10 1 Z\n', '10 1 S\nbroken', '10 1 S\n11 ??? S\n']) {
    assert.deepEqual(await readBrowserMemory([child(10)], {
      platform: 'linux', files, readProcessTable: async () => output,
    }), [null]);
  }
  assert.deepEqual(await readBrowserMemory([child(10)], {
    platform: 'linux', files, readProcessTable: async () => { throw new Error('ps unavailable'); },
  }), [null]);
});

test('discards a browser measurement when its process exits during the sample', async () => {
  const process = child(10);
  assert.deepEqual(await readBrowserMemory([process], {
    platform: 'linux', files, readProcessTable: async () => { process.exitCode = 1; return table; },
  }), [null]);
});

test('keeps another browser available when one tree cannot be measured', async () => {
  for (const [pid, code] of [[10, 'ENOENT'], [11, 'EACCES']]) {
    assert.deepEqual(await readBrowserMemory([child(10), child(20)], {
      platform: 'linux', readProcessTable: async () => table,
      files: {
        async readFile(file) {
          if (file === `/proc/${pid}/smaps_rollup`) throw Object.assign(new Error(code), { code });
          return files.readFile(file);
        },
      },
    }), [null, 240 * 1024]);
  }
});

test('omits an exited helper but still measures its live descendants', async () => {
  assert.deepEqual(await readBrowserMemory([child(10)], {
    platform: 'linux', readProcessTable: async () => table,
    files: {
      async readFile(file) {
        if (file === '/proc/11/smaps_rollup') throw Object.assign(new Error('exited'), { code: 'ENOENT' });
        return files.readFile(file);
      },
    },
  }), [130 * 1024]);
});

test('reports unavailable for malformed or zero PSS instead of inventing memory', async () => {
  for (const rollup of ['', 'Rss: 1000 kB\n', 'Pss: invalid kB\n', 'Pss: 0 kB\n']) {
    assert.deepEqual(await readBrowserMemory([child(10)], {
      platform: 'linux', readProcessTable: async () => '10 1 S\n',
      files: { readFile: async () => rollup },
    }), [null]);
  }
});

const fixture = () => {
  let clock = 1000;
  const runtimes = new Map();
  const manager = createBrowserManager({
    now: () => clock,
    createRuntime: (context) => {
      const runtime = {
        process: child(10), processReads: 0, agentActive: false, tabs: [],
        get browserProcess() { runtime.processReads += 1; return runtime.process; },
        onDead: () => {}, onTabsChanged: () => {},
        async perform(action) {
          if (action === 'browser.bad') throw new Error('Navigation refused');
          return {};
        },
        async command() { throw new Error('Page failed'); },
        async close({ save }) { runtime.saved = save; runtime.closed = true; },
      };
      runtimes.set(context.sessionId, runtime);
      return runtime;
    },
  });
  return { manager, runtimes, advance: (ms) => { clock += ms; } };
};

test('reports action errors and activity only for their chat and clears an error on success', async (t) => {
  const { manager, advance } = fixture();
  t.after(() => manager.close());
  await manager.perform('browser.open', {}, null, { directory: '/repo', sessionId: 'a' });
  await manager.perform('browser.open', {}, null, { directory: '/repo', sessionId: 'b' });
  advance(50);
  await assert.rejects(manager.perform('browser.bad', {}, null, { directory: '/repo', sessionId: 'b' }), /Navigation refused/);
  const [a, b] = manager.state().scopes;
  assert.equal(a.lastActivityAt, 1000);
  assert.equal(a.lastError, null);
  assert.equal(b.lastActivityAt, 1050);
  assert.equal(b.lastError, 'Navigation refused');
  await manager.perform('browser.open', {}, null, { directory: '/repo', sessionId: 'b' });
  assert.equal(manager.state().scopes[1].lastError, null);
});

test('records a dock command error on its selected scope', async (t) => {
  const { manager } = fixture();
  t.after(() => manager.close());
  await manager.perform('browser.open', {}, null, { directory: '/repo', sessionId: 'a' });
  await assert.rejects(manager.navigate('https://test', manager.state().generation), /Page failed/);
  assert.equal(manager.state().scopes[0].lastError, 'Page failed');
});

test('serves on-demand diagnostics and closes only the explicitly named scope', async (t) => {
  const { manager, runtimes } = fixture();
  // Real Linux PSS belongs to this process; descendants in the fixture table are
  // covered above, independently of this live HTTP route and manager wiring.
  await manager.perform('browser.open', {}, null, { directory: '/repo', sessionId: 'a' });
  await manager.perform('browser.open', {}, null, { directory: '/repo', sessionId: 'b' });
  runtimes.get('a').process = child(process.pid);
  runtimes.get('b').process = null;
  const service = createService({ runtime: manager, token: 'test-token' });
  t.after(() => service.close());
  const { port } = await service.listen();
  const origin = `http://127.0.0.1:${port}`;
  const headers = { authorization: 'Bearer test-token' };
  manager.state();
  assert.equal(runtimes.get('a').processReads, 0);
  assert.equal((await fetch(`${origin}/browser/memory`)).status, 401);
  const response = await fetch(`${origin}/browser/memory`, { headers });
  assert.equal(response.status, 200);
  const memory = await response.json();
  const [a, b] = manager.state().scopes;
  assert.equal(memory.sampledAt, 1000);
  assert.deepEqual(memory.scopes.map(({ scopeId }) => scopeId), [a.id, b.id]);
  if (process.platform === 'linux') assert.ok(memory.scopes[0].memoryBytes > 0);
  else assert.equal(memory.scopes[0].memoryBytes, null);
  assert.equal(memory.scopes[1].memoryBytes, null);
  assert.equal(runtimes.get('a').processReads, 1);
  assert.equal(manager.state().scopes[0].lastActivityAt, 1000);
  const closed = await fetch(`${origin}/browser/close-scope`, {
    method: 'POST', headers,
    body: JSON.stringify({ scopeId: b.id, generation: manager.state().generation }),
  });
  assert.equal(closed.status, 200);
  assert.equal(runtimes.get('b').saved, false);
  assert.equal(runtimes.get('a').closed, undefined);
  assert.deepEqual((await closed.json()).scopes.map(({ id }) => id), [a.id]);
});
