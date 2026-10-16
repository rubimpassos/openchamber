import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID } from '@/lib/routing/autoModel';
import { getRuntimeKey } from '@/lib/runtime-switch';
import * as knowledgeApi from '@/lib/sessionKnowledgeApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { routeMessage, useSessionUIStore } from './session-ui-store';
import { ChildStoreManager } from './child-store';
import { setActionRefs, setOptimisticRefs } from './session-actions';
import { setSyncRefs } from './sync-refs';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import { deferSessionOperation, waitForFirstSessionSubmission } from './pending-session-creation';

const directory = '/first-dispatch';
const draft = { draftId: 711, open: true, target: 'project', directoryOverride: directory, parentID: null, preserveDirectoryOverride: true };
let stores, loader, response, inserted, originals, originalConfig, originalCommands, originalFetch, messages, commands;

beforeEach(() => {
  response = deferSessionOperation(); inserted = deferSessionOperation();
  messages = []; commands = [];
  originals = { createSession: opencodeClient.createSession, sendMessage: opencodeClient.sendMessage,
    sendCommand: opencodeClient.sendCommand, getFilesystemHomeInfo: opencodeClient.getFilesystemHomeInfo };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ text: '', signature: '' });
  opencodeClient.createSession = async () => response.promise;
  opencodeClient.sendMessage = async (params) => { messages.push(params); return 'accepted'; };
  opencodeClient.sendCommand = async (params) => { commands.push(params); return 'accepted'; };
  opencodeClient.getFilesystemHomeInfo = async () => ({ home: '/home/test', chatsRoot: '/home/test/chats' });
  originalConfig = useConfigStore.getState(); originalCommands = useCommandsStore.getState();
  useConfigStore.setState({ isConnected: true, hasEverConnected: true, activateDirectory: async () => {}, agents: [] });
  useSessionGoalArmStore.getState().setArmed(false, null);
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  stores = new ChildStoreManager();
  setSyncRefs(opencodeClient.getSdkClient(), stores, directory); setActionRefs(stores, () => directory);
  loader = new SessionMessageLoader(stores, { runtimeKey: getRuntimeKey(), sdk: { getSessionMessages: async () => ({ items: [], cursor: {} }) } });
  setImperativeSessionMessageLoader(loader);
  setOptimisticRefs((input) => {
    loader.optimisticAdd(input);
    if (input.message.role === 'user') inserted.resolve(input.message);
  }, (input) => loader.optimisticRemove(input));
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...draft } });
});

afterEach(() => {
  Object.assign(opencodeClient, originals); globalThis.fetch = originalFetch;
  useConfigStore.setState(originalConfig); useCommandsStore.setState(originalCommands);
  setImperativeSessionMessageLoader(null); loader.dispose(); stores.disposeAll();
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...draft, open: false } });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
});

const send = (providerID = 'provider', modelID = 'model') => useSessionUIStore.getState().sendMessage(
  'first', providerID, modelID, 'build', undefined, undefined, undefined, undefined, 'normal', { draftSnapshot: draft });
const current = (sessionId) => stores.getChild(directory).getState().session.find((session) => session.id === sessionId);
const followUp = (sessionId) => useSessionUIStore.getState().sendMessage('next', 'provider', 'model', 'build',
  undefined, undefined, undefined, undefined, 'normal', { sessionId, directory });

test('compares Auto against the acknowledged model when the first prompt dispatches', async () => {
  // Given a draft that provisionally claims Auto while creation is pending.
  const sending = send(AUTO_PROVIDER_ID, AUTO_MODEL_ID);
  const prompt = await inserted.promise;
  // When the server creates it on a concrete model, as the Auto-omitting create adapter does.
  useConfigStore.setState({ currentProviderId: 'unrelated', currentModelId: 'new-pick' });
  response.resolve({ ...current(prompt.sessionID), model: { providerID: 'server', id: 'fallback' } });
  await sending;
  // Then the first prompt requests the captured Auto switch.
  expect(messages[0].model).toEqual({ providerID: AUTO_PROVIDER_ID, id: AUTO_MODEL_ID });
});

test('compares command selection after its readiness resolves', async () => {
  // Given a provisional record claiming the desired selection.
  const session = { id: 'ses_command', directory, projectID: 'project', title: '', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
    model: { providerID: 'desired', id: 'chosen', variant: 'high' } };
  const store = stores.ensureChild(directory, { bootstrap: false });
  store.setState({ session: [session] });
  useCommandsStore.setState({ commandsByDirectory: { [directory]: [{ name: 'known' }] } });
  const ready = deferSessionOperation();
  // When readiness replaces the record with the server's concrete selection.
  const sending = routeMessage({ sessionId: session.id, directory, content: '/known', providerID: 'desired',
    modelID: 'chosen', variant: 'high', ready: ready.promise });
  store.setState({ session: [{ ...session, model: { providerID: 'server', id: 'fallback' } }] });
  ready.resolve({ sessionId: session.id, directory });
  await sending;
  // Then the command preserves the captured desired choice and sends its required switch.
  expect(commands[0].model).toEqual({ providerID: 'desired', id: 'chosen', variant: 'high' });
});

test('rolls back a waiting follow-up when the acknowledged initial submission fails', async () => {
  // Given two optimistic prompts and an acknowledged canonical directory.
  const delivery = deferSessionOperation(); const started = deferSessionOperation();
  opencodeClient.sendMessage = async (params) => { messages.push(params); started.resolve(); return delivery.promise; };
  const first = send(); const prompt = await inserted.promise;
  inserted = deferSessionOperation();
  const next = followUp(prompt.sessionID); await inserted.promise;
  const canonical = '/canonical-first-dispatch';
  response.resolve({ ...current(prompt.sessionID), directory: canonical }); await started.promise;
  // When the first server submission is rejected.
  delivery.reject(Object.assign(new Error('rejected'), { status: 400 }));
  const results = await Promise.allSettled([first, next]);
  // Then both local bubbles and their loader shadows disappear while the confirmed session remains.
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(messages).toHaveLength(1);
  await loader.ensure({ directory: canonical, sessionID: prompt.sessionID }, { force: true });
  expect(stores.getChild(canonical).getState().message[prompt.sessionID]).toEqual([]);
  expect(useGlobalSessionsStore.getState().entityById.has(prompt.sessionID)).toBe(true);
});

test('makes waiting follow-up knowledge wait for the initial delivery report', async () => {
  // Given knowledge owed until the server acknowledges its held delivery report.
  const report = deferSessionOperation(); const reportStarted = deferSessionOperation();
  const delivery = deferSessionOperation(); const started = deferSessionOperation();
  let knowledgeReads = 0; let reported = false;
  const originalReport = knowledgeApi.reportSessionKnowledgeDelivered;
  const heldAtReport = [];
  const observeReport = spyOn(knowledgeApi, 'reportSessionKnowledgeDelivered').mockImplementation((scope, id, signature) => {
    heldAtReport.push(waitForFirstSessionSubmission(id) !== undefined);
    return originalReport(scope, id, signature);
  });
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/session-knowledge/delivered')) {
      reportStarted.resolve(); await report.promise; reported = true; return Response.json({});
    }
    if (url.includes('/session-knowledge?')) {
      knowledgeReads += 1;
      return Response.json(reported ? { text: '', signature: '' } : { text: 'context', signature: 'v1' });
    }
    return Response.json({});
  };
  opencodeClient.sendMessage = async (params) => {
    messages.push(params);
    if (messages.length === 1) { started.resolve(); await delivery.promise; }
    return 'accepted';
  };
  const first = send(); const prompt = await inserted.promise;
  inserted = deferSessionOperation(); const next = followUp(prompt.sessionID); await inserted.promise;
  // When the first prompt is accepted but its knowledge report is still in flight.
  response.resolve(current(prompt.sessionID)); await started.promise; delivery.resolve();
  await first; await reportStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    // Then the first send resolves promptly, but its follower cannot read and resend stale knowledge.
    expect(heldAtReport).toEqual([true]);
    expect(knowledgeReads).toBe(1);
    expect(messages).toHaveLength(1);
  } finally {
    report.resolve(); await next; observeReport.mockRestore();
  }
  expect(messages[1].context ?? []).toEqual([]);
});
