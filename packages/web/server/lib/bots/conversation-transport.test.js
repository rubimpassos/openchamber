import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { OpenCode } from '@opencode/client';
import { afterEach, expect, it } from 'vitest';
import { createBotDriver } from './runtime.test-support.js';
import { createBotsRuntime } from './runtime.js';
import { createBotExecutionServices } from './agent-execution.js';
import { createAgentBotServices } from '../agent-server/bot-services.js';
import { createAgentUpstream } from '../agent-server/agent-upstream.js';
import { registerBotServiceRoutes } from '../agent-server/bot-service-routes.js';
import { createBotConversationHttpGuard } from './conversation-http.js';
import { registerBotRoutes } from './routes.js';
import { createSpaceDispatcher } from '../spaces/dispatcher.js';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const serve = async (app) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
};
const fixture = async (options = {}) => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-conversation-transport-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return createBotDriver(root, { held: ['investigation'], ...options });
};

it('keeps authenticated ensure idempotent and guards native SDK sends without dropping files or selection', async () => {
  const f = await fixture();
  const item = await f.admit();
  const native = [];
  const peer = express();
  peer.post('/auth/session', express.json(), (_req, res) => res.set('Set-Cookie', 'oc_ui_session=peer; Max-Age=3600; Path=/').json({ ok: true }));
  peer.post('/api/session/:id/prompt', express.json(), (req, res) => {
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBe('oc_ui_session=peer');
    native.push(req.body); res.json({ data: { id: req.body.id ?? 'msg_native' } });
  });
  const agent = createAgentUpstream({ url: await serve(peer), token: 'peer' });
  cleanups.push(() => agent.close());
  const dispatcher = createSpaceDispatcher({ upstream: agent });
  cleanups.push(() => dispatcher.close());
  const app = express();
  app.use((req, res, next) => req.headers.authorization === 'Bearer fixture' ? next() : res.sendStatus(401));
  app.use(createBotConversationHttpGuard({ runtime: f.runtime, assertStarted() {} }));
  registerBotRoutes(app, { botsRuntime: f.runtime,
    identities: { list: async () => [], create: async () => {}, update: async () => {}, remove: async () => {} } });
  app.use((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    return dispatcher.forwardRequest(req, res, url.pathname, url.search);
  });
  const baseUrl = await serve(app);
  const route = `${baseUrl}/api/projects/project/bots/items/${item.id}/conversation`;
  expect((await fetch(route, { method: 'POST' })).status).toBe(401);
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(route, { method: 'POST', headers: { authorization: 'Bearer fixture' } });
    expect(await response.json()).toEqual({ conversation: item.conversation });
  }
  const client = OpenCode.make({ baseUrl, headers: { authorization: 'Bearer fixture' } });
  const input = { sessionID: item.conversation.sessionId, id: 'msg_native0001', text: 'Explain this',
    files: [{ uri: 'file:///project/proof.txt', name: 'proof.txt', source: { type: 'uri', uri: 'file:///project/proof.txt' } }],
    skills: [{ id: 'research' }], delivery: 'steer' };
  await client.session.prompt(input);
  const { sessionID: _id, ...body } = input;
  expect(f.calls.nativePrompts).toEqual([input]);
  expect(native).toEqual([]);
  const changed = await fetch(`${baseUrl}/api/session/${item.conversation.sessionId}/prompt`, {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, text: 'Changed content' }),
  });
  expect(changed.status).toBe(409);
  expect(f.calls.nativePrompts).toHaveLength(1);
  const mutation = await fetch(`${baseUrl}/api/session/${item.conversation.sessionId}`, {
    method: 'PATCH', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] }),
  });
  expect(mutation.status).toBe(403);
  const stopped = await fetch(`${baseUrl}/api/session/${item.conversation.sessionId}/interrupt`, {
    method: 'POST', headers: { authorization: 'Bearer fixture' },
  });
  expect(stopped.status).toBe(200);
  await expect(client.session.prompt({ ...input, id: 'msg_native0002' })).rejects.toThrow();
  expect(f.calls.nativePrompts).toHaveLength(1);
});

it('creates, reconciles, accounts and stops through typed execution without a checkout or host fallback', async () => {
  const f = await fixture();
  const execution = createBotExecutionServices({ agentServer: true, dataDir: path.join(f.project.path, 'agent'),
    readSettings: async () => ({ projects: [f.project] }), listProjects: async () => [f.project],
    clientFor: () => f.client, sessionService: f.sessionService, sessionKnowledgeRuntime: {
      sync: async () => true, collect: async () => ({ notes: [], plans: [], memory: { enabled: false, complete: true, global: [], project: [] } }),
    }, readSessionDefaults: async () => ({ providerID: 'test', modelID: 'model' }),
    permissionAutoAcceptRuntime: { setSessionPolicy: async () => {} },
    activity: { fetchActiveSessionStatuses: async () => ({}), hasWorkingDescendants: async () => false, hasWorkingChildren: async () => false },
    readTokens: async () => f.controls.conversationTokens ?? 0,
    worktrees: { resolveTransferSource: async () => { throw new Error('Conversation touched a checkout'); } },
    buildOpenCodeUrl: () => { throw new Error('Unexpected fallback'); }, getOpenCodeAuthHeaders: () => ({}),
  });
  cleanups.push(() => execution.stop());
  const app = express();
  app.post('/auth/session', express.json(), (_req, res) => res.set('Set-Cookie', 'oc_ui_session=fixture; Max-Age=3600; Path=/').json({ ok: true }));
  app.use('/api', (req, res, next) => req.headers.cookie === 'oc_ui_session=fixture' ? next() : res.sendStatus(401));
  registerBotServiceRoutes(app, { agentServer: true, services: execution });
  const upstream = createAgentUpstream({ url: await serve(app), token: 'fixture' });
  cleanups.push(() => upstream.close());
  const delegated = createAgentBotServices(upstream, {
    dataDir: path.join(f.project.path, 'owner'), resolveProject: async () => f.project, listProjects: async () => [f.project],
    readItem: async (_project, id) => (await f.store.read('project')).items.find((item) => item.id === id),
  });
  const runtime = createBotsRuntime({ ...f.dependencies, conversations: delegated.conversations });
  const item = await runtime.admit('project', 'bugs', { source: { kind: 'manual', id: 'remote' }, title: 'Remote item' });
  expect(item.worktree).toBeUndefined();
  expect((await runtime.ensureConversation('project', item.id)).conversation).toEqual(item.conversation);
  await runtime.admitConversationMessage({ sessionId: item.conversation.sessionId, operationId: 'typed-chat',
    text: 'Explain', payload: { text: 'Explain' } });
  const native = { sessionId: item.conversation.sessionId, operationId: 'typed-native',
    operation: 'prompt', text: 'Explain the evidence', payload: { id: 'msg_typed0001', text: 'Explain the evidence',
      files: [{ uri: 'file:///project/evidence.txt', name: 'evidence.txt', description: 'Proof',
        source: { type: 'uri', uri: 'file:///project/evidence.txt' }, mention: { start: 0, end: 5, text: 'proof' }, mime: 'text/plain' },
        { uri: 'data:text/plain;base64,QQ==', source: { type: 'inline' } }],
      agents: [{ name: 'build' }, { name: 'research', mention: { start: 6, end: 14, text: 'research' } }],
      skills: [{ id: 'proof' }, { id: 'review', mention: { start: 15, end: 21, text: 'review' } }],
      configuration: { custom: true } } };
  await runtime.dispatchConversationNative(native);
  await runtime.dispatchConversationNative(native);
  expect(f.calls.nativePrompts).toEqual([{ ...native.payload, sessionID: item.conversation.sessionId }]);
  f.controls.conversationTokens = 8;
  await runtime.recordUsage({ sessionId: item.conversation.sessionId, total: 8 });
  expect((await runtime.detail('project', item.id)).item.tokens.conversation).toBe(8);
  const journal = await import('./execution-store.js').then(({ createBotExecutionStore }) => createBotExecutionStore({ store: f.store }).read('project', item.id));
  await expect(delegated.conversations.ensure({ ...journal.data.conversationCapture, itemId: 'borrowed' })).rejects.toMatchObject({ code: 'BOT_CONVERSATION_SCOPE_MISMATCH' });
  await runtime.stopItem('project', item.id);
  expect(f.calls.interrupts).toContain(item.conversation.sessionId);
});

it('preserves a literal percent in the native SDK directory query without decoding it twice', async () => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-percent%-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const f = await createBotDriver(root, { held: ['investigation'] });
  const item = await f.admit();
  const app = express();
  app.use(createBotConversationHttpGuard({ runtime: f.runtime, assertStarted() {} }));
  const origin = await serve(app);
  const body = { id: 'msg_percent0001', text: 'Explain this proof' };
  const query = new URLSearchParams({ 'location[directory]': f.project.path });
  const response = await fetch(`${origin}/api/session/${item.conversation.sessionId}/prompt?${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  expect(f.calls.nativePrompts).toEqual([{ ...body, sessionID: item.conversation.sessionId }]);
});

it('admits the real session service and refuses its native SDK dispatch after Stop', async () => {
  const f = await fixture();
  const item = await f.admit();
  f.sessionService.setDispatchAdmission(f.runtime.admitConversationMessage);
  const input = { directory: f.project.path, prompt: 'Explain this proof', model: 'test/model', agent: 'build' };
  expect((await f.sessionService.send(item.conversation.sessionId, input)).promptDispatched).toBe(true);
  await f.runtime.stopItem('project', item.id);
  await expect(f.sessionService.send(item.conversation.sessionId, input)).rejects.toThrow();
  expect(f.calls.prompts.map((prompt) => prompt.text)).toEqual(['Explain this proof']);
});

it('keeps an ordinary queued message undelivered when the owner budget refuses it', async () => {
  const f = await fixture({ bot: { limits: { dailyTokens: 10 } } });
  const item = await f.admit();
  const writes = [];
  const result = Promise.withResolvers();
  const queue = createMessageQueueRuntime({ dataDir: path.join(f.project.path, 'queue'),
    globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
    buildOpenCodeUrl: (route) => `http://controlled.invalid${route}`, getOpenCodeAuthHeaders: () => ({}),
    dispatchQuietMs: 0, onPromptSent: () => result.resolve('sent'),
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (init?.method === 'POST') writes.push({ path: pathname, body: JSON.parse(init.body) });
      if (pathname.endsWith('/active')) return Response.json({ data: {} });
      if (pathname.endsWith('/message')) return Response.json({ data: [], cursor: {} });
      return Response.json({ data: f.sessions.get(item.conversation.sessionId) });
    } });
  cleanups.push(async () => { queue.stop(); await queue.drain(); });
  queue.setDispatchAdmission(async (input) => {
    try { await f.runtime.admitConversationMessage(input); }
    catch (error) { result.resolve('refused'); throw error; }
  });
  f.controls.conversationTokens = 1_000_000;
  queue.start();
  await queue.enqueue(item.conversation.sessionId, f.project.path, { content: 'Explain', text: 'Explain',
    sendConfig: { providerID: 'test', modelID: 'model', agent: 'build' } });
  expect(await result.promise).toBe('refused');
  queue.stop(); await queue.drain();
  expect(writes).toEqual([]);
  expect(queue.sessionSnapshot(item.conversation.sessionId).items.map((entry) => entry.text)).toEqual(['Explain']);
});
