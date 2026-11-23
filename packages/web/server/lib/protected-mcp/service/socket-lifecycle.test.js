import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { engineRequest } from '../test-support/fixtures.js';
import { toPublicStatus } from './contract.js';
import { createEngineSocketServer } from './engine-socket.js';
import { createFallbackBackend, createSessionManager } from './mcp-session.js';
import { openStore, parseOperation } from './store.js';
import { createSubjectListeners } from './subject-listeners.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const root = await fs.mkdtemp('/tmp/opencode/pmcp-sockets-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openStore({ stateDir: path.join(root, 'state') });
  cleanups.push(store.close);
  await store.apply(parseOperation({ kind: 'create', definition: { name: 'fixture', transport: 'http', http: { url: 'https://example.test/mcp' } } }));
  const definition = store.get(store.adminViews()[0].id);
  const sessions = createSessionManager({ store, version: 'test', startBackend: () => createFallbackBackend({ message: 'synthetic', version: 'test' }) });
  const status = () => toPublicStatus({ version: 'test', administration: 'shared', enforcement: { status: 'unverified', checkedAt: 0, findings: [] }, connections: store.list() });
  return { root, store, definition, sessions, status };
}

it('preserves ready-before-MCP ordering when hello carries initial session bytes', async () => {
  // Given a real listener and an in-process MCP backend with no network requests.
  const f = await setup();
  const socketPath = path.join(f.root, 'engine.sock');
  const listener = createEngineSocketServer({ path: socketPath, store: f.store, sessions: f.sessions, status: f.status });
  cleanups.push(async () => { f.sessions.closeAll(); await listener.close(); });
  await listener.listen();
  const socket = net.createConnection(socketPath);
  cleanups.push(() => socket.destroy());
  const replies = new Promise((resolve, reject) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n').filter(Boolean);
      if (lines.length === 2) resolve(lines.map((line) => JSON.parse(line)));
    });
  });
  await once(socket, 'connect');
  // When one write includes both the validated hello and a ping.
  socket.write(`${JSON.stringify({ type: 'hello', protocol: 1, connection: f.definition.id })}\n${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
  // Then readiness precedes the response to the preserved initial bytes.
  expect(await replies).toEqual([{ type: 'ready', connection: f.definition.id, name: 'fixture' }, { jsonrpc: '2.0', id: 7, result: {} }]);
});

it('closes unfinished clients when the listener stops', async () => {
  // Given a connected client that has not sent its first frame.
  const f = await setup();
  const listener = createEngineSocketServer({ path: path.join(f.root, 'engine.sock'), store: f.store, sessions: f.sessions, status: f.status });
  cleanups.push(listener.close);
  await listener.listen();
  const socket = net.createConnection(path.join(f.root, 'engine.sock'));
  cleanups.push(() => socket.destroy());
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  // When shutdown starts without waiting for a hello.
  await listener.close();
  // Then the client closes without holding shutdown open.
  await closed;
  expect(socket.destroyed).toBe(true);
});

it('drains ordered mutations before closing when subject work is still queued', async () => {
  // Given a stable subject directory and a real store.
  const f = await setup();
  const subjectsDir = path.join(f.root, 'subjects');
  const directory = path.join(subjectsDir, 'agent');
  await fs.mkdir(directory, { recursive: true });
  const inode = (await fs.stat(directory)).ino;
  const listeners = createSubjectListeners({ subjectsDir, store: f.store, sessions: f.sessions });
  cleanups.push(listeners.close);
  // When creation, removal and recreation are queued before shutdown.
  const work = [listeners.set('agent', [f.definition.id]), listeners.remove('agent'), listeners.set('agent', [])];
  await listeners.close();
  // Then shutdown drains in order, preserves the directory and closes the last listener.
  expect(await Promise.all(work)).toEqual([{ subject: 'agent', connections: [f.definition.id] }, undefined, { subject: 'agent', connections: [] }]);
  expect(f.store.subjects()).toEqual([{ subject: 'agent', connections: [] }]);
  expect((await fs.stat(directory)).ino).toBe(inode);
  await expect(engineRequest(path.join(directory, 'engine.sock'), { type: 'status' })).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ECONNREFUSED/) });
});

it('continues the queue when a new grant is refused', async () => {
  // Given a real store with no grant and a syntactically valid unknown connection id.
  const f = await setup();
  const subjectsDir = path.join(f.root, 'subjects');
  const listeners = createSubjectListeners({ subjectsDir, store: f.store, sessions: f.sessions });
  cleanups.push(listeners.close);
  // When a refused creation is followed immediately by a valid creation.
  const results = await Promise.allSettled([listeners.set('agent', ['pmcp_ffffffffffffffff']), listeners.set('agent', [])]);
  // Then the refused listener is cleaned up and the next queued listener works.
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'unknown_connection' } });
  expect(results[1]).toEqual({ status: 'fulfilled', value: { subject: 'agent', connections: [] } });
  expect(await engineRequest(path.join(subjectsDir, 'agent', 'engine.sock'), { type: 'status' })).toEqual([{ type: 'error', code: 'unsupported_request' }]);
});
