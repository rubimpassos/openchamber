import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { engineSession } from '../test-support/fixtures.js';
import { createEngineSocketServer } from './engine-socket.js';
import { createFallbackBackend, createLineReader, createSessionManager } from './mcp-session.js';
import { openStore, parseOperation } from './store.js';
import { parseSubject } from './subject-contract.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(startBackend) {
  const root = await fs.mkdtemp('/tmp/opencode/pmcp-session-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openStore({ stateDir: path.join(root, 'state') });
  cleanups.push(store.close);
  await store.apply(parseOperation({ kind: 'create', definition: { name: 'fixture', transport: 'http', http: { url: 'https://example.test/mcp' } } }));
  const view = store.adminViews()[0];
  if (!view) throw new Error('fixture view missing');
  const definition = store.get(view.id);
  if (!definition) throw new Error('fixture definition missing');
  const sessions = createSessionManager({ store, version: 'test', startBackend });
  const received = Promise.withResolvers();
  const engineSessions = {
    countAll: sessions.countAll,
    open(definition, socket, context) {
      socket.once('data', () => received.resolve());
      sessions.open(definition, socket, context);
    },
  };
  const socketPath = path.join(root, 'engine.sock');
  const listener = createEngineSocketServer({ path: socketPath, subject: parseSubject('agent'), store: { get: store.get, subjectAllows: () => true }, sessions: engineSessions });
  cleanups.push(async () => { sessions.closeAll(); await listener.close(); });
  await listener.listen();
  const client = engineSession(socketPath, definition.id);
  cleanups.push(() => client.close());
  await client.next();
  return { client, definition, sessions, store, received: received.promise };
}

it('keeps initialization and authorization guidance working when backend startup rejects', async () => {
  // Given an unavailable backend without any external connection attempt.
  const f = await setup(() => Promise.reject(Object.assign(new Error('synthetic'), { code: 'runtime_installing' })));
  // When the client initializes and uses the existing fallback protocol.
  f.client.send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 'fixture-protocol' } });
  const initialized = (await f.client.response('init')).message;
  f.client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = (await f.client.response(2)).message;
  f.client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'authorization_required' } });
  const called = (await f.client.response(3)).message;
  // Then negotiation and the single guidance tool survive the failed start.
  expect(initialized.result.protocolVersion).toBe('fixture-protocol');
  expect(listed.result.tools.map((tool) => tool.name)).toEqual(['authorization_required']);
  expect(called.result).toEqual({ content: [{ type: 'text', text: initialized.result.instructions }], isError: true });
});

it('flushes queued batches in order when the backend becomes ready', async () => {
  // Given a backend whose readiness is controlled by the fixture.
  const { promise, resolve } = Promise.withResolvers();
  const f = await setup(() => promise);
  const forwarded = [];
  const backend = createFallbackBackend({ message: 'fixture', version: 'test' });
  // When requests and a notification arrive before readiness.
  f.client.send([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  await f.received;
  resolve({ ...backend, send(message) { forwarded.push(message); backend.send(message); } });
  // Then both requests are answered in their original order.
  expect(await f.client.next()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  expect(await f.client.next()).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  expect(forwarded.map((message) => message.method)).toEqual(['ping', 'notifications/initialized', 'ping']);
});

it('closes a backend that finishes starting after its session ended', async () => {
  // Given a session still waiting for its backend.
  const startup = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const f = await setup(() => startup.promise);
  const backend = createFallbackBackend({ message: 'fixture', version: 'test' });
  backend.onClose(() => closed.resolve());
  // When shutdown precedes completion of backend startup.
  f.sessions.closeAll();
  startup.resolve(backend);
  await closed.promise;
  // Then no session remains and the late backend is closed.
  expect(f.sessions.countAll()).toBe(0);
});

it('applies live policy and declared argument defaults to a running backend', async () => {
  // Given a local backend that declares one tool argument and echoes calls.
  let emit = () => {};
  const f = await setup(() => ({
    send(message) {
      emit({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list'
        ? { tools: [{ name: 'echo', inputSchema: { properties: { org: {} } } }, { name: 'hidden' }] }
        : message.params });
    },
    onMessage(callback) { emit = callback; },
    onClose() {},
    close() {},
  }));
  await f.store.apply(parseOperation({ kind: 'update', id: f.definition.id, expectedRevision: f.definition.revision,
    definition: { name: 'fixture', transport: 'http', http: { url: 'https://example.test/mcp' },
      policy: { allowTools: ['echo*'], defaultArguments: { org: 'default-org', undeclared: 'ignored' } } } }));
  // When the already-open client lists tools and calls the allowed tool.
  f.client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const listed = (await f.client.response(1)).message;
  f.client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { query: 'x' } } });
  const defaulted = (await f.client.response(2)).message;
  f.client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { org: 'client-org' } } });
  const overridden = (await f.client.response(3)).message;
  f.client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hidden' } });
  const refused = (await f.client.response(4)).message;
  // Then filtering, missing defaults, explicit values and refusal match the live policy.
  expect(listed.result.tools.map((tool) => tool.name)).toEqual(['echo']);
  expect(defaulted.result.arguments).toEqual({ query: 'x', org: 'default-org' });
  expect(overridden.result.arguments).toEqual({ org: 'client-org' });
  expect(refused.result.isError).toBe(true);
});

it('keeps fragmented JSON and malformed-line recovery for stdio readers', () => {
  // Given the same reader contract the JavaScript stdio adapter imports.
  const values = [];
  let invalid = 0;
  const read = createLineReader({ onValue: (value) => values.push(value), onInvalid: () => { invalid += 1; } });
  // When a message spans chunks and follows a malformed line.
  read(Buffer.from('invalid\n{"id":'));
  read(Buffer.from('1}\n\n{"id":2}\n'));
  // Then the invalid line is dropped and complete messages remain ordered.
  expect(values).toEqual([{ id: 1 }, { id: 2 }]);
  expect(invalid).toBe(1);
});
