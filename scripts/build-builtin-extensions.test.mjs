import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildBuiltInExtensions } from './build-builtin-extensions.mjs';
import { readBuiltInRegistry } from '../packages/web/server/lib/guests/builtins.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const temporary = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-builtin-build-'));
  roots.push(root);
  return root;
};

describe('built-in extension build', () => {
  test('a declared host socket dependency works in a self-contained Node service bundle', async () => {
    const root = await temporary();
    const sourceRoot = path.join(root, 'source');
    const service = path.join(sourceRoot, 'fixture/service');
    await fs.mkdir(service, { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'registry.json'), JSON.stringify({ version: 1, extensions: [{
      id: 'openchamber-builtin-fixture', directory: 'fixture', files: [],
      build: [{ entry: 'service/source.js', out: 'service/main.js', target: 'node' }],
    }] }));
    await fs.writeFile(path.join(sourceRoot, 'fixture/package.json'), JSON.stringify({
      name: 'builtin-fixture', version: '0.0.1', type: 'module', dependencies: { ws: '^8.18.3' },
      openchamber: { apiVersion: 1, contributes: {
        panel: { id: 'openchamber-builtin-fixture', name: 'Fixture', icon: 'apps' },
        service: { entry: 'service/main.js', runtime: 'host', provides: ['browser'], surface: true },
      } },
    }));
    await fs.writeFile(path.join(service, 'source.js'), `
      import { once } from 'node:events';
      import { WebSocket, WebSocketServer } from 'ws';
      export async function roundTrip() {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await once(server, 'listening');
        server.on('connection', (socket) => socket.once('message', (data) => socket.send(data)));
        const socket = new WebSocket('ws://127.0.0.1:' + server.address().port);
        await once(socket, 'open');
        socket.send('bundled socket works');
        const [message] = await once(socket, 'message');
        socket.close();
        await once(socket, 'close');
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        return message.toString();
      }
    `);
    const outDir = path.join(root, 'bundle');
    await buildBuiltInExtensions({ sourceRoot, outDir });

    const bundle = pathToFileURL(path.join(outDir, 'fixture/service/main.js')).href;
    const run = spawnSync(process.execPath.includes('bun') ? 'node' : process.execPath, [
      '--input-type=module', '-e', `const m=await import(${JSON.stringify(bundle)});console.log(await m.roundTrip());`,
    ], { cwd: outDir, encoding: 'utf8', timeout: 5000 });

    expect({ status: run.status, stderr: run.stderr, error: run.error?.message }).toEqual({
      status: 0, stderr: '', error: undefined,
    });
    expect(run.stdout.trim()).toBe('bundled socket works');
  });

  test.skipIf(process.platform === 'win32')('publishes a traversable catalog when build and runtime users differ', async () => {
    const root = await temporary();
    const sourceRoot = path.join(root, 'source');
    const outDir = path.join(root, 'bundle');
    await fs.mkdir(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, 'registry.json'), JSON.stringify({ version: 1, extensions: [] }));

    await buildBuiltInExtensions({ sourceRoot, outDir });
    expect((await fs.stat(outDir)).mode & 0o777).toBe(0o755);

    // Rebuilding must also replace the owner-only permissions of older bundles.
    await fs.chmod(outDir, 0o700);
    await buildBuiltInExtensions({ sourceRoot, outDir });
    expect((await fs.stat(outDir)).mode & 0o777).toBe(0o755);
    expect((await readBuiltInRegistry(outDir)).extensions).toEqual([]);
  });

  test('builds a fixture using only the public SDK and stamps the app version', async () => {
    const root = await temporary();
    const sourceRoot = path.join(root, 'source');
    const panel = path.join(sourceRoot, 'fixture/panel');
    await fs.mkdir(panel, { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'registry.json'), JSON.stringify({ version: 1, extensions: [{
      id: 'openchamber-builtin-fixture', directory: 'fixture', files: ['panel/index.html'],
      build: [{ entry: 'panel/main.ts', out: 'panel/main.js', target: 'browser' }],
    }] }));
    await fs.writeFile(path.join(sourceRoot, 'fixture/package.json'), JSON.stringify({
      name: 'builtin-fixture', version: '0.0.1', openchamber: { apiVersion: 1, contributes: {
        panel: { id: 'openchamber-builtin-fixture', name: 'Fixture', icon: 'apps', entry: 'panel/index.html' },
        capabilities: ['sessions', 'files'],
      } },
    }));
    await fs.writeFile(path.join(panel, 'index.html'), '<!doctype html><main id="root"></main><script src="./main.js"></script>');
    await fs.writeFile(path.join(panel, 'main.ts'), 'import { connectHost } from "@openchamber/sdk"; connectHost().onReady(() => {});');
    const outDir = path.join(root, 'bundle');
    const result = await buildBuiltInExtensions({ sourceRoot, outDir });
    const registry = await readBuiltInRegistry(outDir);
    expect(registry.extensions).toEqual(result.extensions);
    expect(registry.extensions).toHaveLength(1);
    const demo = path.join(outDir, 'fixture');
    const manifest = JSON.parse(await fs.readFile(path.join(demo, 'package.json'), 'utf8'));
    const app = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.version).toBe(app.version);
    expect(manifest.openchamber.contributes.capabilities).toEqual(['sessions', 'files']);
    expect((await fs.stat(path.join(demo, 'panel/main.js'))).size).toBeGreaterThan(0);
    expect((await fs.readdir(path.join(demo, 'panel'))).sort()).toEqual(['index.html', 'main.js']);
    expect(Object.keys(result.extensions[0]).sort()).toEqual(['directory', 'id']);
    await buildBuiltInExtensions({ sourceRoot, outDir: `${outDir}${path.sep}` });
    expect((await readBuiltInRegistry(outDir)).extensions).toEqual(result.extensions);
    expect((await fs.readdir(root)).sort()).toEqual(['bundle', 'source']);
  });

  test('an empty registry removes previously shipped extension resources', async () => {
    const root = await temporary();
    const sourceRoot = path.join(root, 'source');
    const outDir = path.join(root, 'bundle');
    await fs.mkdir(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, 'registry.json'), JSON.stringify({ version: 1, extensions: [] }));
    await fs.mkdir(path.join(outDir, 'retired-extension'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'retired-extension/main.js'), 'old bundle');
    await buildBuiltInExtensions({ sourceRoot, outDir });
    expect((await readBuiltInRegistry(outDir)).extensions).toEqual([]);
    expect(await fs.readdir(outDir)).toEqual(['registry.json']);
  });

  test('a failed build keeps the previous complete bundle', async () => {
    const root = await temporary();
    const sourceRoot = path.join(root, 'source');
    const outDir = path.join(root, 'bundle');
    await fs.mkdir(path.join(sourceRoot, 'broken'), { recursive: true });
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(outDir, 'previous'), 'keep');
    await fs.writeFile(path.join(sourceRoot, 'registry.json'), JSON.stringify({ version: 1, extensions: [{
      id: 'openchamber-builtin-broken', directory: 'broken', files: [], build: [],
    }] }));
    await fs.writeFile(path.join(sourceRoot, 'broken/package.json'), JSON.stringify({ name: 'broken', openchamber: {} }));
    await expect(buildBuiltInExtensions({ sourceRoot, outDir })).rejects.toThrow();
    expect(await fs.readFile(path.join(outDir, 'previous'), 'utf8')).toBe('keep');
    expect((await fs.readdir(root)).some((name) => name.startsWith('.builtin-build-'))).toBe(false);
  });

  test('rejects duplicate IDs and source paths outside the declared package', async () => {
    const root = await temporary();
    const sourceRoot = path.join(root, 'source');
    await fs.mkdir(sourceRoot);
    const entry = { id: 'openchamber-builtin-fixture', directory: 'fixture', files: [], build: [] };
    await fs.writeFile(path.join(sourceRoot, 'registry.json'), JSON.stringify({ version: 1, extensions: [entry, entry] }));
    await expect(buildBuiltInExtensions({ sourceRoot, outDir: path.join(root, 'out') })).rejects.toThrow();
    await fs.writeFile(path.join(sourceRoot, 'registry.json'), JSON.stringify({ version: 1, extensions: [{ ...entry, files: ['../secret'] }] }));
    await expect(buildBuiltInExtensions({ sourceRoot, outDir: path.join(root, 'out') })).rejects.toThrow();
  });
});
