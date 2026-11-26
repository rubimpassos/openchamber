import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { createBotIsolatedStages } from './isolated-stages.js';
import { createBotArtifactCapture } from './artifacts-capture.js';
import { createHostArtifacts } from './host-artifacts.js';
import { createBotStore } from './store.js';
import { createBotItem } from './schema.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotPlacement } from './placement.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { createBotArtifactService, registerBotArtifactServiceRoutes } from '../agent-server/bot-artifact-services.js';
import { createSpaceJourney } from '../spaces/journey.js';
import { createSpaceManager } from '../spaces/manager.js';
import { createSpaceRecords } from '../spaces/space-records.js';
import { createSpaceDispatcher } from '../spaces/dispatcher.js';
import { createSpaceOpenCode } from '../spaces/space-opencode.js';
import { createSpaceArchive } from '../spaces/space-archive.js';
import { SpaceError } from '../spaces/errors.js';

export const cleanupSpaceId = 'abcdef123456';
export const cleanupScope = { projectId: 'project', itemId: 'item' };
const directory = `/spaces/${cleanupSpaceId}/project`;
export const cleanupBinding = { ...cleanupScope, botId: 'bot', sessionId: 'ses_cleanup', directory,
  producer: { role: 'stage', stage: 'fixing' } };
const quiet = { warn() {}, info() {} };

export async function isolatedCleanupFixture(options = {}) {
  const root = await fs.mkdtemp('/tmp/opencode/stopped-space-fix-');
  const sourceDir = path.join(root, 'source');
  const state = {
    running: false, gatekeeperRunning: true, removed: false, starts: 0, stops: 0, collects: 0,
    policy: { mode: 'open', domains: ['old.example.test'], grants: ['openai'] },
    fail: null, onStart: async () => {}, onArchive: async () => {}, onCollect: async () => {},
    subjectConnections: ['pmcp_0123456789abcdef'], subjectAnswers: [], events: [],
  };
  const bindingFile = path.join(root, 'bots', 'isolated-stages', `${digestMutationInput(cleanupScope)}.json`);
  await fs.mkdir(path.dirname(bindingFile), { recursive: true });
  await fs.writeFile(bindingFile, JSON.stringify({ version: 1, ...cleanupScope, botId: 'bot', hostDirectory: '/host/worktree',
    state: 'ready', spaceId: cleanupSpaceId, directory, sessions: { run: { id: cleanupBinding.sessionId, stage: 'fixing', directory } },
    ...options.binding }));
  const records = createSpaceRecords({ dataDir: root, logger: quiet });
  records.write(cleanupSpaceId, { placeId: options.kind ?? 'docker', repository: '/host/project', spacePath: directory,
    name: 'Retained work', network: { mode: 'open', domains: ['old.example.test'] },
    grants: [{ kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing' }, ...(options.grants ?? [])] });
  const source = createBotArtifactCapture({ dataDir: sourceDir, resolveSession: async () => cleanupBinding, onCaptured: async () => {} });
  const capture = (callId) => source.capture({ title: callId, body: { format: 'html', content: `<p>${callId}</p>` } },
    { sessionId: cleanupBinding.sessionId, callId, directory });
  const reference = options.empty ? null : await capture('retained-evidence');
  const app = express();
  app.post('/auth/session', (_req, res) => res.set('set-cookie', 'space=fixture; Max-Age=3600').json({}));
  app.use((req, res, next) => req.get('cookie') === 'space=fixture' ? next() : res.sendStatus(401));
  app.post('/api/session/:id/interrupt', (_req, res) => { state.events.push('interrupt'); res.json({ data: {} }); });
  app.get('/api/session/active', (_req, res) => res.json({ data: state.fail === 'activity' ? { [cleanupBinding.sessionId]: {} } : {} }));
  const exported = { info: { id: cleanupBinding.sessionId, projectID: 'project', title: 'Retained chat', time: { created: 1, updated: 2 },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    messages: [{ id: 'msg_retained', type: 'assistant', parts: [{ type: 'text', text: 'Retained answer' }] }] };
  app.get('/api/experimental/session/:id/export', (_req, res) => res.json({ data: exported }));
  registerBotArtifactServiceRoutes(app, { service: createBotArtifactService({ capture: source, resolveBinding: async () => cleanupBinding }), placement: 'space', isAllowed: () => true });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const requireRunning = () => { if (!state.running || state.removed) throw new SpaceError('space_not_running', 'The producer has exited'); };
  const listed = () => state.removed ? [] : [{ id: cleanupSpaceId, name: 'Retained work', project: 'project', created: '',
    state: state.running ? 'running' : 'exited', gatekeeperRunning: state.gatekeeperRunning, damaged: false, missing: [], orphans: [] }];
  const place = {
    id: options.kind ?? 'docker', kind: options.kind ?? 'docker', list: async () => listed(),
    stop: async () => {
      state.stops++; state.events.push('stop'); state.running = false; state.gatekeeperRunning = false;
      state.policy = { mode: 'allowlist', domains: [], grants: [] }; server.closeAllConnections();
    },
    start: async () => {
      state.starts++; state.events.push('start'); state.running = true; state.gatekeeperRunning = true;
      await state.onStart();
      if (state.fail === 'start') throw new SpaceError('start_failed', 'Startup failed after starting the producer');
    },
    remove: async () => {
      if (state.fail === 'remove') throw new SpaceError('remove_failed', 'Runtime removal failed');
      state.events.push('remove'); state.running = false; state.gatekeeperRunning = false; state.removed = true;
      return { removed: [], failed: [] };
    },
    verify: async () => state.fail === 'verify' ? [{ check: 'isolation', message: 'Unverified' }] : [],
    connect: async () => { requireRunning(); return net.connect({ host: '127.0.0.1', port: server.address().port }); },
  };
  const places = { get: () => place, list: () => [place] };
  const manager = createSpaceManager({ registry: places, locate: async () => place.id });
  const dispatcher = createSpaceDispatcher({ transport: {
    listSpaceIds: async () => ({ ids: listed().map((entry) => entry.id), failure: null }),
    readToken: async () => { requireRunning(); return 'fixture-token'; },
    connect: place.connect,
  } });
  const spaceOpenCode = createSpaceOpenCode({ exec: manager.exec, requestInside: dispatcher.requestInside });
  const imported = new Map();
  const archive = createSpaceArchive({ dataDir: root, logger: quiet, hostOpenCode: {
    importChat: async (chat) => { imported.set(chat.info.id, chat); }, removeChat: async (id) => { imported.delete(id); },
  } });
  const journey = createSpaceJourney({
    manager, places, records, spaceOpenCode, logger: quiet, folderExists: async () => true,
    gatekeeper: {
      readPolicy: async () => { if (state.fail === 'policy-read') throw new SpaceError('policy_failed', 'Cannot read policy'); return state.policy; },
      addGrant: async (_id, grant) => { await options.deliver?.(); state.policy.grants.push(grant.id); },
    },
    codeIn: { removeSpaceRefs: async () => { state.events.push('refs'); } },
    codeOut: {}, serverInside: {}, listProjectDirectories: async () => ['/host/project'],
    mcpSubjects: {
      set: async (_subject, connections) => {
        state.events.push(connections.length ? 'restore-mcp' : 'clear-mcp');
        const answer = state.subjectAnswers.shift() ?? { ok: true };
        if (answer.ok) state.subjectConnections = connections;
        return answer;
      },
      remove: async () => { state.subjectConnections = []; return { ok: true }; },
    },
    archiveChats: async (request) => {
      state.events.push('archive'); await state.onArchive();
      if (state.fail === 'archive') throw new SpaceError('chats_not_saved', 'Archive unavailable');
      return archive.saveChats({ ...request, source: {
        listChats: async () => ({ chats: [{ id: cleanupBinding.sessionId, title: exported.info.title }], complete: true }),
        exportChat: (id) => spaceOpenCode.exportChat(cleanupSpaceId, id),
      } });
    },
  });
  const host = { manager, journey, dispatcher };
  const build = () => createBotIsolatedStages({ dataDir: root, getSpacesHost: () => host, resolveProject: async () => ({ id: 'project', path: '/host/project' }),
    sessionKnowledgeRuntime: { collect: async () => ({}) }, handleTool: async () => { throw new Error('Coordinator authority escaped cleanup'); },
    collectArtifacts: async (sessionId) => {
      state.collects++; state.events.push('collect'); await state.onCollect();
      if (state.fail === 'transfer') throw new Error('Transfer failed');
      await artifactHost.collect(sessionId);
    },
  });
  const adapter = build();
  const store = createBotStore({ projectsDirPath: path.join(root, 'projects') });
  await store.update(cleanupScope.projectId, (snapshot) => ({ snapshot: { ...snapshot, items: [
    { ...createBotItem({ id: cleanupScope.itemId, botId: cleanupBinding.botId, title: 'Retained work', source: { kind: 'manual', id: 'retained' } }), worktree: '/host/worktree' },
  ] } }));
  const journal = createBotExecutionStore({ store });
  const artifactHost = createHostArtifacts({ dataDir: path.join(root, 'owner'), store, journal,
    placement: createBotPlacement({ dataDir: root, journal, isolated: adapter }), isolated: adapter,
    listProjects: async () => [{ id: cleanupScope.projectId }],
    resolveProject: async () => ({ id: cleanupScope.projectId, path: '/host/project' }),
    clientFor: () => { throw new Error('Cleanup must not use host sessions'); }, activity: null,
    dispatchConversationNative: async () => { throw new Error('Cleanup must not dispatch a turn'); }, broadcast: () => {},
  });
  const artifacts = artifactHost.artifacts;
  return { root, state, records, host, adapter, build, artifacts, source, sourceDir, capture, reference, archive, imported, bindingFile,
    exit: () => { state.running = false; server.closeAllConnections(); },
    remove: () => adapter.remove({ project: { id: 'project' }, bot: { id: 'bot' }, item: { id: 'item', worktree: '/host/worktree' } }),
    stop: () => adapter.stop({ sessionId: cleanupBinding.sessionId }),
    close: async () => { dispatcher.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); },
  };
}
