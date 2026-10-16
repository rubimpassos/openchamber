import { afterEach, beforeEach, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { markWorktreeBootstrapPending, clearWorktreeBootstrapState } from '@/lib/worktrees/worktreeBootstrap';
import { createPendingDraftWorktreeRequest, resolvePendingDraftWorktreeRequest } from '@/lib/worktrees/pendingDraftWorktree';
import { ChildStoreManager } from './child-store';
import { setActionRefs } from './session-actions';
import { setSyncRefs } from './sync-refs';
import { materializeOpenDraftSession, useSessionUIStore } from './session-ui-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';

const root = '/preparation-project';
const worktree = '/preparation-project/trees/topic';
const selection = { providerID: 'provider', modelID: 'model' };
const setup = {
  trust: { hash: null, trusted: true }, setupWorktree: [], setupWorktreeWait: true,
  projectActions: [], projectActionsPrimaryId: null, draftStarters: [],
  shared: { status: 'missing', path: '.openchamber/project.json', setupWorktree: [], setupWorktreeWait: null,
    projectActions: [], draftStarters: [], plansDir: null },
  personal: { setupWorktree: [], setupWorktreeWait: null, setupWorktreeMode: 'append', projectActions: [],
    projectActionsPrimaryId: null, draftStarters: [], hiddenSharedActionIds: [], sharedTrust: null },
};
let stores, loader, originalConfig, originalFetch, originalCreate, requests, creates, bootstrap, statusRead;
let nextSession = 0;

beforeEach(() => {
  requests = []; creates = [];
  bootstrap = Promise.withResolvers(); statusRead = Promise.withResolvers();
  originalFetch = globalThis.fetch; originalCreate = opencodeClient.createSession;
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.includes('/worktrees/bootstrap-status')) { statusRead.resolve(); return bootstrap.promise; }
    return Response.json(/\/api\/projects\/.*\/config/.test(url) ? setup : {});
  };
  opencodeClient.createSession = async (_params, directory) => {
    creates.push(directory);
    return { id: `ses_prepared_${++nextSession}`, directory, projectID: 'project', title: '', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } };
  };
  originalConfig = useConfigStore.getState();
  useConfigStore.setState({ activateDirectory: async () => {}, isConnected: true, agents: [] });
  useProjectsStore.setState({ projects: [{ id: 'project', path: root }], activeProjectId: 'project' });
  useDirectoryStore.getState().setDirectory(root, { showOverlay: false });
  stores = new ChildStoreManager();
  setSyncRefs(opencodeClient.getSdkClient(), stores, root); setActionRefs(stores, () => root);
  loader = new SessionMessageLoader(stores, { sdk: { getSessionMessages: async () => ({ items: [], cursor: {} }) }, runtimeKey: getRuntimeKey() });
  setImperativeSessionMessageLoader(loader);
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, availableWorktreesByProject: new Map() });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
});

afterEach(() => {
  clearWorktreeBootstrapState(worktree);
  globalThis.fetch = originalFetch; opencodeClient.createSession = originalCreate;
  useConfigStore.setState(originalConfig);
  setImperativeSessionMessageLoader(null); loader.dispose(); stores.disposeAll();
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
});

const openDraft = (directory, extra = {}) => {
  const draft = { draftId: 1, open: true, target: 'project', selectedProjectId: 'project', directoryOverride: directory,
    parentID: null, preserveDirectoryOverride: true, ...extra };
  useSessionUIStore.setState({ newSessionDraft: draft });
  return draft;
};

test('skips worktree setup HTTP reads when a draft targets its ordinary project root', async () => {
  // Given a ready root draft with no bootstrap or worktree identity.
  const draft = openDraft(root);
  // When it materializes.
  await materializeOpenDraftSession(selection, draft);
  // Then session creation needs no setup configuration round trip.
  expect(creates).toEqual([root]);
  expect(requests.filter((url) => /\/api\/projects\/.*\/config/.test(url))).toEqual([]);
});

test('waits for worktree setup when a pending worktree request resolves', async () => {
  // Given a draft waiting for a newly created worktree and its setup.
  const requestId = createPendingDraftWorktreeRequest();
  const draft = openDraft(root, { pendingWorktreeRequestId: requestId });
  markWorktreeBootstrapPending(worktree);
  const materializing = materializeOpenDraftSession(selection, draft);
  resolvePendingDraftWorktreeRequest(requestId, worktree);
  // When the configured setup wait reaches its directory's pending bootstrap read.
  await statusRead.promise;
  expect(creates).toEqual([]);
  bootstrap.resolve(Response.json({ status: 'ready', phase: 'setup-ready', error: null, updatedAt: 1 }));
  await materializing;
  // Then creation starts only after setup succeeds in the chosen worktree.
  expect(creates).toEqual([worktree]);
  expect(requests.filter((url) => /\/api\/projects\/.*\/config/.test(url))).toHaveLength(1);
});
