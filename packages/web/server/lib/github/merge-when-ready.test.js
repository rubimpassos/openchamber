import { describe, expect, it, vi } from 'vitest';
import { cancelWaitingMerge, enableMergeWhenReady, mergeWhenReadyInQueue, readMergeOptions } from './merge-when-ready.js';

const project = { owner: 'acme', name: 'app' };
const target = { number: 7, base: 'main', headSha: 'abc' };
const pull = (overrides = {}) => ({ id: 'PR_7', state: 'OPEN', headRefOid: 'abc', mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED', isInMergeQueue: false, autoMergeRequest: null, ...overrides });
const client = (pr = pull(), queue = null) => ({ graphql: vi.fn(async (query) => {
  if (query.startsWith('query')) return { repository: { pullRequest: pr, mergeQueue: queue } };
  if (query.includes('enablePullRequestAutoMerge')) return { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: '2026-11-03' } } } };
  if (query.includes('disablePullRequestAutoMerge')) return { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } };
  return { dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } };
}) });

describe('GitHub merge when ready', () => {
  it('enables auto-merge with the chosen method and an expected head guard', async () => {
    const octokit = client();
    expect(await enableMergeWhenReady(octokit, project, target, 'squash')).toEqual({ merged: false, outcome: 'auto-merge' });
    expect(octokit.graphql.mock.calls[1][1]).toEqual({ id: 'PR_7', mergeMethod: 'SQUASH', sha: 'abc' });
    expect(octokit.graphql.mock.calls[1][0]).toContain('expectedHeadOid: $sha');
  });
  it.each([
    [pull(), { id: 'MQ' }], [pull({ state: 'CLOSED' }), null], [pull({ headRefOid: 'moved' }), null],
    [pull({ mergeable: 'CONFLICTING' }), null], [pull({ mergeStateStatus: 'CLEAN' }), null],
  ])('does not auto-merge a queue, moved head, conflict or a settled pull', async (pr, queue) => {
    const octokit = client(pr, queue);
    expect(await enableMergeWhenReady(octokit, project, target, 'merge')).toBeNull();
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
  it('preserves a refusal when the state read fails', async () => {
    expect(await enableMergeWhenReady({ graphql: async () => { throw new Error('offline'); } }, project, target, 'merge')).toBeNull();
  });
  it('passes on a refused auto-merge without claiming it was enabled', async () => {
    const octokit = client();
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull(), mergeQueue: null } }))
      .mockImplementationOnce(async () => { throw new Error('Auto-merge is not allowed'); });
    await expect(enableMergeWhenReady(octokit, project, target, 'merge')).rejects.toThrow('Auto-merge is not allowed');
  });
  it('dequeues and disables any remaining auto-merge request', async () => {
    const octokit = client(pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }));
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }))
      .mockImplementationOnce(async () => ({ dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } }))
      .mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: false, outcome: 'cancelled' });
    expect(octokit.graphql.mock.calls[1][0]).toContain('dequeuePullRequest(input: { id: $id })');
    expect(octokit.graphql.mock.calls[3][0]).toContain('disablePullRequestAutoMerge');
  });
  it('does not disable again when dequeue already cleared auto-merge', async () => {
    const octokit = client();
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }))
      .mockImplementationOnce(async () => ({ dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: false, outcome: 'cancelled' });
    expect(octokit.graphql).toHaveBeenCalledTimes(3);
  });
  it('reports a merge that won the race with cancellation truthfully', async () => {
    const octokit = client(pull({ state: 'MERGED' }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: true });
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
});

const settingsAnswer = ({ settings = {}, linear = false, admin = false } = {}) => ({ repository: {
  mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, ...settings,
  pullRequest: { viewerCanMergeAsAdmin: admin, baseRef: { branchProtectionRule: linear ? { requiresLinearHistory: true } : null } },
} });
const rulesAnswer = ({ rules = [], queue = false } = {}) => ({ repository: {
  pullRequest: { isMergeQueueEnabled: queue, baseRef: { rules: { nodes: rules } } },
} });

describe('GitHub merge options', () => {
  const ref = { owner: 'acme', repo: 'app', number: 7 };
  const read = (settings, rules) => readMergeOptions({ graphql: vi.fn(async (query) => {
    if (!query.includes('rules(')) return settings;
    if (rules instanceof Error) throw rules;
    return rules;
  }) }, ref);

  it('keeps the methods both the settings and the base branch rules allow', async () => {
    expect(await read(settingsAnswer({ settings: { mergeCommitAllowed: false } }),
      rulesAnswer({ rules: [{ type: 'PULL_REQUEST', parameters: { allowedMergeMethods: ['REBASE', 'MERGE'] } }] })))
      .toEqual({ methods: ['rebase'], queue: null, canBypass: false });
  });
  it('drops merge commits under a linear-history rule or classic protection', async () => {
    expect((await read(settingsAnswer(), rulesAnswer({ rules: [{ type: 'REQUIRED_LINEAR_HISTORY', parameters: null }] }))).methods).toEqual(['squash', 'rebase']);
    expect((await read(settingsAnswer({ linear: true }), rulesAnswer())).methods).toEqual(['squash', 'rebase']);
  });
  it('reports the base branch queue, its method, and whether the viewer may bypass', async () => {
    expect(await read(settingsAnswer({ admin: true }), rulesAnswer({ queue: true, rules: [{ type: 'MERGE_QUEUE', parameters: { mergeMethod: 'REBASE' } }] })))
      .toEqual({ methods: ['merge', 'squash', 'rebase'], queue: { method: 'rebase' }, canBypass: true });
  });
  it('still narrows by the settings when the rules cannot be read', async () => {
    expect(await read(settingsAnswer({ settings: { mergeCommitAllowed: false, squashMergeAllowed: false } }), new Error('Field rules does not exist')))
      .toEqual({ methods: ['rebase'], queue: null, canBypass: false });
  });
  it('is null for a number that is no pull request, and refuses a malformed answer', async () => {
    expect(await read({ repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: null } }, rulesAnswer())).toBeNull();
    await expect(read({ repository: { pullRequest: {} } }, rulesAnswer())).rejects.toThrow('invalid merge options');
  });
});

describe('GitHub merge when ready on a queue branch', () => {
  it('enables auto-merge without a method, guarded by the head', async () => {
    const octokit = client(pull(), { id: 'MQ' });
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull(), mergeQueue: { id: 'MQ' } } }))
      .mockImplementationOnce(async () => ({ enablePullRequestAutoMerge: { pullRequest: { isInMergeQueue: false, autoMergeRequest: { enabledAt: 'now' } } } }));
    expect(await mergeWhenReadyInQueue(octokit, project, target)).toEqual({ merged: false, outcome: 'auto-merge' });
    expect(octokit.graphql.mock.calls[1][0]).not.toContain('mergeMethod');
    expect(octokit.graphql.mock.calls[1][1]).toEqual({ id: 'PR_7', sha: 'abc' });
  });
  it('reports a ready PR that GitHub queued at once', async () => {
    const octokit = client(pull(), { id: 'MQ' });
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull(), mergeQueue: { id: 'MQ' } } }))
      .mockImplementationOnce(async () => ({ enablePullRequestAutoMerge: { pullRequest: { isInMergeQueue: true, autoMergeRequest: null } } }));
    expect(await mergeWhenReadyInQueue(octokit, project, target)).toEqual({ merged: false, outcome: 'queued' });
  });
  it('asks nothing again for a PR already queued or waiting', async () => {
    const queued = client(pull({ isInMergeQueue: true }), { id: 'MQ' });
    expect(await mergeWhenReadyInQueue(queued, project, target)).toEqual({ merged: false, outcome: 'queued' });
    expect(queued.graphql).toHaveBeenCalledTimes(1);
  });
  it('refuses a base branch without a queue as a definite failure', async () => {
    await expect(mergeWhenReadyInQueue(client(), project, target)).rejects.toMatchObject({ message: 'The base branch has no merge queue', status: 409 });
  });
});
