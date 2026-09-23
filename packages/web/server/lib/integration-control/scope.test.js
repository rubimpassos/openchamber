import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';
import { ACTIONS, ERROR_DEFINITIONS } from './contract.js';
import { createIntegrationScope, IntegrationScopeError } from './scope.js';

const credential = { domainId: 'alpha', projectIds: ['alpha'], actions: [...ACTIONS] };
const input = (sessionId = 'alpha-existing') => ({ projectId: 'alpha', sessionId, prompt: 'Continue' });
const errorShape = (code) => ({ code, ...ERROR_DEFINITIONS[code] });
let root;
let alpha;
let beta;
let worktree;
let settings;
let sessions;
let list;
let scope;
let control;
let sessionService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scope-'));
  alpha = path.join(root, 'alpha');
  beta = path.join(root, 'alpha-neighbor');
  worktree = path.join(root, 'worktrees', 'feature');
  await Promise.all([alpha, beta, worktree].map((directory) => fs.mkdir(directory, { recursive: true })));
  // Minimal on-disk Git metadata: exercise the real rev-parse resolver without
  // creating commits, running hooks, or touching the checkout's Git state.
  const gitDir = path.join(alpha, '.git');
  const linkedGitDir = path.join(gitDir, 'worktrees', 'feature');
  await Promise.all(['objects', 'refs', 'worktrees/feature'].map((directory) => fs.mkdir(path.join(gitDir, directory), { recursive: true })));
  await Promise.all([
    fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n'),
    fs.writeFile(path.join(linkedGitDir, 'HEAD'), 'ref: refs/heads/feature\n'),
    fs.writeFile(path.join(linkedGitDir, 'commondir'), '../..\n'),
    fs.writeFile(path.join(linkedGitDir, 'gitdir'), `${worktree}/.git\n`),
    fs.writeFile(path.join(worktree, '.git'), `gitdir: ${linkedGitDir}\n`),
  ]);
  settings = { projects: [{ id: 'alpha', path: alpha, label: 'Alpha' }, { id: 'beta', path: beta, label: 'Beta' }] };
  sessions = [
    { id: 'alpha-existing', directory: alpha, title: 'Existing' },
    { id: 'beta-existing', directory: beta, title: 'Private beta' },
    { id: 'alpha-human', directory: alpha, title: 'Human session' },
    { id: 'alpha-worktree', directory: worktree, title: 'Worktree session' },
  ];
  list = vi.fn(async () => ({ data: sessions }));
  const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process, realpathSync });
  const readSettingsFromDiskMigrated = async () => settings;
  const dependencies = {
    readSettingsFromDiskMigrated,
    sanitizeProjects: normalization.sanitizeProjects,
    ...createProjectDirectoryRuntime({ fsPromises: fs, path, ...normalization, readSettingsFromDiskMigrated }),
  };
  sessionService = { send: vi.fn(async (sessionId, payload) => ({ sessionId, ...payload })), fork: vi.fn(async (sessionId, payload) => ({ sourceSessionId: sessionId, ...payload })) };
  control = createOpenChamberControlService({
    ...dependencies, sessionService,
    buildOpenCodeUrl: () => 'http://127.0.0.1:1',
    getOpenCodeAuthHeaders: () => ({}),
    createClient: () => ({ experimental: { session: { list } } }),
  });
  scope = createIntegrationScope({ ...dependencies, controlService: control });
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('integration project and session authorization', () => {
  it('authorizes an existing session using its persisted owner', async () => {
    const result = await scope.authorize(credential, 'session.send', input());
    expect(result).toEqual({ action: 'session.send', projectId: 'alpha', sessionId: 'alpha-existing', directory: alpha,
      controlInput: { sessionId: 'alpha-existing', prompt: 'Continue', directory: alpha } });
    expect(list).toHaveBeenCalledWith({});
    expect(sessionService.send).not.toHaveBeenCalled();
  });

  it.each(['session.send', 'session.fork', 'session.status', 'session.messages'])('%s hides foreign and missing sessions identically', async (action) => {
    const payload = (sessionId) => ({ projectId: 'alpha', sessionId, ...(['session.send', 'session.fork'].includes(action) ? { prompt: 'Continue' } : {}) });
    for (const sessionId of ['beta-existing', 'missing']) {
      const error = await scope.authorize(credential, action, payload(sessionId)).catch((failure) => failure);
      expect(error).toBeInstanceOf(IntegrationScopeError);
      expect(error).toMatchObject(errorShape('SESSION_NOT_FOUND'));
      expect(Object.keys(error).sort()).toEqual(['code', 'name', 'statusCode']);
    }
  });

  it('checks claimed project even when both projects are authorized', async () => {
    await expect(scope.authorize({ ...credential, projectIds: ['alpha', 'beta'] }, 'session.send', input('beta-existing')))
      .rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
  });

  it('accepts a human session with no plugin-origin metadata', async () => {
    expect(sessions.find(({ id }) => id === 'alpha-human')).toEqual({ id: 'alpha-human', directory: alpha, title: 'Human session' });
    await expect(scope.authorize(credential, 'session.messages', { projectId: 'alpha', sessionId: 'alpha-human', lastAssistant: true }))
      .resolves.toMatchObject({ projectId: 'alpha', sessionId: 'alpha-human', directory: alpha,
        controlInput: { sessionId: 'alpha-human', directory: alpha, lastAssistant: true } });
  });

  it.each(['session.send', 'session.fork'])('%s preserves the recognized worktree through native dispatch', async (action) => {
    const authorized = await scope.authorize(credential, action, input('alpha-worktree'));
    expect(authorized).toMatchObject({ projectId: 'alpha', directory: worktree });
    expect(authorized.controlInput).not.toHaveProperty('projectId');
    await control.execute(action, authorized.controlInput, beta);
    const operation = action === 'session.send' ? sessionService.send : sessionService.fork;
    expect(operation).toHaveBeenCalledWith('alpha-worktree', { directory: worktree, prompt: 'Continue' });
  });

  it('denies fork origin mismatches and disallows a separate destination', async () => {
    await expect(scope.authorize(credential, 'session.fork', input('beta-existing'))).rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
    await expect(scope.authorize(credential, 'session.fork', { ...input(), directory: beta })).rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
    expect(sessionService.fork).not.toHaveBeenCalled();
  });

  it('fails closed on owner I/O failure, malformed response, and missing directory', async () => {
    list.mockRejectedValueOnce(new Error('Synthetic metadata I/O failure'));
    await expect(scope.authorize(credential, 'session.send', input())).rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
    list.mockResolvedValueOnce({ error: 'unavailable' });
    await expect(scope.authorize(credential, 'session.send', input())).rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
    sessions[0] = { id: 'alpha-existing' };
    await expect(scope.authorize(credential, 'session.send', input())).rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
  });

  it('filters sessions by resolved identity, before limit, without directory or project leakage', async () => {
    const rows = [{ ...sessions[1], directory: alpha, projectId: 'alpha' }, ...sessions];
    expect(await scope.filterSessions(credential, { projectId: 'alpha', limit: 2 }, rows))
      .toEqual([{ id: 'alpha-existing', title: 'Existing' }, { id: 'alpha-human', title: 'Human session' }]);
    expect(await scope.filterSessions(credential, { projectId: 'alpha' }, sessions)).toHaveLength(3);
    list.mockRejectedValue(new Error('Synthetic owner failure'));
    expect(await scope.filterSessions(credential, { projectId: 'alpha' }, sessions)).toEqual([]);
  });

  it('projects.list returns only policy projects and never paths', async () => {
    expect(await scope.filterProjects(credential)).toEqual([{ id: 'alpha', label: 'Alpha' }]);
    expect(await scope.filterProjects({ ...credential, projectIds: [] })).toEqual([]);
  });

  it('canonicalizes registered symlinks and rejects a session symlink retargeted to beta', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(alpha, alias);
    settings.projects[0].path = alias;
    sessions[0].directory = alias;
    await expect(scope.authorize(credential, 'session.send', input())).resolves.toMatchObject({ projectId: 'alpha', directory: alpha });
    settings.projects[0].path = alpha;
    await fs.unlink(alias);
    await fs.symlink(beta, alias);
    await expect(scope.authorize(credential, 'session.send', input())).rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
  });

  it('does not authorize a path neighbor or unregistered directory by textual prefix', async () => {
    sessions[0].directory = path.join(root, 'alpha-extra');
    await fs.mkdir(sessions[0].directory);
    await expect(scope.authorize(credential, 'session.send', input())).rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
    await expect(scope.authorize(credential, 'session.create', { projectId: 'alpha-extra' })).rejects.toMatchObject(errorShape('PROJECT_DENIED'));
  });

  it('authorizes root creation, denies beta projects, and checks wire actions before owner reads', async () => {
    await expect(scope.authorize(credential, 'session.create', { projectId: 'alpha', worktree: 'new-feature' }))
      .resolves.toMatchObject({ projectId: 'alpha', directory: alpha, controlInput: { directory: alpha, worktree: 'new-feature' } });
    await expect(scope.authorize(credential, 'session.create', { projectId: 'beta' })).rejects.toMatchObject(errorShape('PROJECT_DENIED'));
    await expect(scope.authorize({ ...credential, actions: [] }, 'session.send', input())).rejects.toMatchObject(errorShape('ACTION_DENIED'));
    await expect(scope.authorize({ ...credential, actions: ['schedule.run'] }, 'schedule.run', {})).rejects.toMatchObject(errorShape('ACTION_DENIED'));
    expect(list).not.toHaveBeenCalled();
  });

  it('denies unresolved registered paths rather than using their textual IDs', async () => {
    settings.projects[0].path = path.join(root, 'missing');
    await expect(scope.authorize(credential, 'session.create', { projectId: 'alpha' })).rejects.toMatchObject(errorShape('PROJECT_DENIED'));
    await expect(scope.authorize(credential, 'session.send', input())).rejects.toMatchObject(errorShape('SESSION_NOT_FOUND'));
  });
});
