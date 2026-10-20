import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMcpStore } from './mcp-local.js';
import { materializeLocalMcpPlugin } from './mcp-local-plugin.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-local-plugin-'));
  cleanups.push(() => fs.rm(root, { force: true, recursive: true }));
  const dataDir = path.join(root, 'private');
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  await Promise.all([fs.mkdir(project), fs.mkdir(other)]);
  const directory = await materializeLocalMcpPlugin({ dataDir });
  const { default: plugin } = await import(pathToFileURL(path.join(directory, 'index.js')).href);
  const store = createLocalMcpStore({ dataDir });
  return { root, project, other, dataDir, directory, plugin, store };
}

// The driver replays every transform over fresh lower-layer state on each reload.
function driver(plugin, directory, lower = {}) {
  const transforms = [];
  let state;
  let count = 0;
  const waiters = [];
  const replay = () => {
    state = structuredClone(lower);
    for (const transform of transforms) transform({ set: (name, value) => { state[name] = value; } });
  };
  const ctx = { location: { directory }, mcp: {
    transform: (transform) => { transforms.push(transform); },
    reload: async () => {
      replay();
      count++;
      for (const resolve of waiters.splice(0)) resolve();
    },
  } };
  const ready = Promise.resolve(plugin.setup(ctx)).then((cleanup) => {
    cleanups.push(cleanup);
    replay();
    return cleanup;
  });
  return {
    ready,
    state: () => state,
    count: () => count,
    nextReload: () => new Promise((resolve) => waiters.push(resolve)),
  };
}
const local = { type: 'local', command: ['node', 'server.js'] };

describe('managed project-local MCP plugin', () => {
  it('expands references at runtime while preserving the private stored definition', async () => {
    const { project, plugin, store } = await fixture();
    vi.stubEnv('MCP_LOCAL_TEST_REFERENCE', 'from-env');
    vi.stubEnv('MCP_LOCAL_TEST_ABSENT', undefined);
    await fs.writeFile(path.join(project, 'reference.txt'), '  from-file\n');
    const config = { ...local, environment: {
      ENV: '{env:MCP_LOCAL_TEST_REFERENCE}', FILE: '{file:reference.txt}',
      ABSENT_ENV: '{env:MCP_LOCAL_TEST_ABSENT}', ABSENT_FILE: '{file:absent.txt}',
    } };
    await store.create('tools', config, project);
    const active = driver(plugin, project);
    await active.ready;
    expect(active.state().tools.environment).toEqual({ ENV: 'from-env', FILE: 'from-file', ABSENT_ENV: '', ABSENT_FILE: '' });
    expect(store.read(project).servers.tools).toEqual(config);
  });

  it('loads its generated package without host dependencies and overlays only its location', async () => {
    const { project, other, plugin, store } = await fixture();
    await store.create('tools', local, project);
    const first = driver(plugin, project);
    const second = driver(plugin, other);
    await Promise.all([first.ready, second.ready]);
    expect(plugin.id).toBe('openchamber-project-local-mcp');
    expect(first.state()).toEqual({ tools: local });
    expect(second.state()).toEqual({});
  });

  it('reloads a live location after atomic writes and restores lower layers after deletion', async () => {
    const { project, other, store, plugin } = await fixture();
    const lower = { type: 'remote', url: 'https://lower.invalid' };
    const active = driver(plugin, project, { tools: lower });
    const isolated = driver(plugin, other);
    await Promise.all([active.ready, isolated.ready]);
    // Given a location subscribed before its first local file exists.
    let next = active.nextReload();
    await store.create('tools', local, project);
    await next;
    expect(active.state()).toEqual({ tools: local });
    next = active.nextReload();
    await store.update('tools', { disabled: true }, project);
    await next;
    expect(active.state().tools.disabled).toBe(true);
    // When removing the override.
    next = active.nextReload();
    await store.remove('tools', project);
    await next;
    // Then fresh replay exposes the original lower-layer entry.
    expect(active.state()).toEqual({ tools: lower });
    expect(isolated.count()).toBe(0);
  });

  it('preserves last valid data on malformed changes and logs no payload', async () => {
    const { project, store, plugin } = await fixture();
    const { path: filename } = await store.create('tools', local, project);
    const active = driver(plugin, project);
    await active.ready;
    let logged;
    const observed = new Promise((resolve) => { logged = resolve; });
    const error = vi.spyOn(console, 'error').mockImplementation(logged);
    // When an external write corrupts the watched file.
    await fs.writeFile(filename, '{"secret":"do-not-log"');
    await observed;
    // Then replay retains the previous configuration without leaking the secret.
    expect(active.state()).toEqual({ tools: local });
    expect(active.count()).toBe(0);
    expect(JSON.stringify(error.mock.calls)).not.toContain('do-not-log');
  });

  it('removes the overlay when the file disappears', async () => {
    const { project, store, plugin } = await fixture();
    const { path: filename } = await store.create('tools', local, project);
    const active = driver(plugin, project);
    await active.ready;
    const next = active.nextReload();
    await fs.rm(filename);
    await next;
    expect(active.state()).toEqual({});
  });

  it('ignores identical writes and other filenames and stops queued work on cleanup', async () => {
    const { project, store, plugin, dataDir } = await fixture();
    const { path: filename } = await store.create('tools', local, project);
    const active = driver(plugin, project);
    const cleanup = await active.ready;
    await fs.writeFile(path.join(dataDir, 'mcp-project-local', 'unrelated.json'), '{}');
    await store.update('tools', {}, project);
    // A subsequent semantic change acts as a completion barrier for preceding events.
    const next = active.nextReload();
    await store.update('tools', { disabled: true }, project);
    await next;
    expect(active.count()).toBe(1);
    await cleanup();
    await store.remove('tools', project);
    expect(active.state().tools.disabled).toBe(true);
    expect(active.count()).toBe(1);
    expect((await fs.stat(filename)).isFile()).toBe(true);
  });
});
