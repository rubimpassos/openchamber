import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFeedbackAuthorPermission, readPullFeedback } from './pr-feedback.js';

for (const permission of ['admin', 'write', 'read', 'none']) {
  test(`feedback author trust follows the repository's ${permission} base permission`, async () => {
    const calls = [];
    const octokit = { rest: { repos: { getCollaboratorPermissionLevel: async (input) => {
      calls.push(input);
      return { data: { permission, role_name: 'custom-role', user: { login: 'Alice' } } };
    } } } };
    assert.equal(await readFeedbackAuthorPermission({ octokit, owner: 'acme', repo: 'app', username: 'alice' }),
      permission === 'admin' || permission === 'write');
    assert.deepEqual(calls, [{ owner: 'acme', repo: 'app', username: 'alice' }]);
  });
}

for (const data of [undefined, {}, { permission: 'maintain', user: { login: 'alice' } },
  { permission: 'write', user: null }, { permission: 'write', user: { login: 'other-user' } }]) {
  test(`malformed or mismatched feedback authority is not trusted: ${JSON.stringify(data)}`, async () => {
    const octokit = { rest: { repos: { getCollaboratorPermissionLevel: async () => ({ data }) } } };
    await assert.rejects(readFeedbackAuthorPermission({ octokit, owner: 'acme', repo: 'app', username: 'alice' }));
  });
}

for (const status of [401, 403, 404, 429, 500]) {
  test(`feedback permission HTTP ${status} remains an unknown read`, async () => {
    const error = Object.assign(new Error('Permission read failed'), { status });
    const octokit = { rest: { repos: { getCollaboratorPermissionLevel: async () => { throw error; } } } };
    await assert.rejects(readFeedbackAuthorPermission({ octokit, owner: 'acme', repo: 'app', username: 'alice' }),
      (actual) => actual === error);
  });
}

const connection = (nodes = []) => ({ nodes, pageInfo: { hasPreviousPage: false, hasNextPage: false } });
const comment = () => ({ databaseId: 1, body: 'Please fix', url: 'https://github.com/a/b/pull/1#comment', createdAt: '2026-10-15T00:00:00Z', author: null });
const thread = () => ({ id: 'thread', isResolved: true, isOutdated: false, path: 'file.js', line: 1, comments: connection([comment()]) });
const check = () => ({ __typename: 'CheckRun', databaseId: 1, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null, detailsUrl: null, checkSuite: null });
const snapshot = () => ({
  viewer: { login: 'viewer' },
  repository: { pullRequest: {
    number: 1, title: 'Fix', url: 'https://github.com/a/b/pull/1', state: 'OPEN',
    headRefName: 'fix', headRefOid: 'head', baseRefName: 'main', reviewDecision: null,
    headRepository: { id: 'repo-fork', name: 'b', owner: { login: 'contributor' } },
    reviews: connection(), reviewThreads: connection([thread()]), comments: connection(),
    commits: { nodes: [{ commit: { oid: 'head', statusCheckRollup: { contexts: connection([check()]) } } }] },
  } },
});
const pull = (data) => data.repository.pullRequest;
const commit = (data) => pull(data).commits.nodes[0].commit;
const read = (data) => readPullFeedback({ octokit: { graphql: async () => data }, owner: 'a', repo: 'b', number: 1 });

test('returns complete feedback with successful CI', async () => {
  // Given
  const data = snapshot();
  // When
  const result = await read(data);
  // Then
  assert.equal(result.ci.state, 'success');
  assert.equal(result.ci.total, 1);
  assert.equal(result.threads[0].comments[0].body, 'Please fix');
  assert.deepEqual(result.headRepo, { id: 'repo-fork', owner: 'contributor', repo: 'b' });
});

test('accepts a full page when GitHub confirms it is complete', async () => {
  // Given
  const data = snapshot();
  pull(data).reviewThreads = connection(Array.from({ length: 100 }, thread));
  // When
  const result = await read(data);
  // Then
  assert.equal(result.threads.length, 100);
});

test('requests completeness metadata for all bounded feedback connections', async () => {
  // Given
  let document;
  const octokit = { graphql: async (query) => { document = query; return snapshot(); } };
  // When
  await readPullFeedback({ octokit, owner: 'a', repo: 'b', number: 1 });
  // Then
  assert.equal(document.match(/pageInfo\s*\{\s*hasPreviousPage\s+hasNextPage\s*\}/g).length, 5);
});

for (const rollup of [null, { contexts: connection() }]) {
  test(`accepts confirmed no checks with ${rollup === null ? 'null rollup' : 'empty contexts'}`, async () => {
    // Given
    const data = snapshot();
    commit(data).statusCheckRollup = rollup;
    // When
    const result = await read(data);
    // Then
    assert.equal(result.ci.total, 0);
    assert.deepEqual(result.ci.contexts, []);
  });
}

const truncated = [
  ['more than 100 threads', (data) => {
    pull(data).reviewThreads = connection(Array.from({ length: 100 }, thread));
    pull(data).reviewThreads.pageInfo.hasPreviousPage = true;
  }],
  ['more than 30 nested comments', (data) => {
    const comments = connection(Array.from({ length: 30 }, comment));
    comments.pageInfo.hasNextPage = true;
    pull(data).reviewThreads.nodes[0].comments = comments;
  }],
  ['more than 100 CI contexts', (data) => {
    commit(data).statusCheckRollup.contexts = connection(Array.from({ length: 100 }, check));
    commit(data).statusCheckRollup.contexts.pageInfo.hasNextPage = true;
  }],
  ['more than 50 reviews', (data) => { pull(data).reviews.pageInfo.hasPreviousPage = true; }],
  ['more than 50 conversation comments', (data) => { pull(data).comments.pageInfo.hasPreviousPage = true; }],
];
for (const [name, change] of truncated) {
  test(`rejects truncated feedback with ${name}`, async () => {
    // Given
    const data = snapshot();
    change(data);
    // When / Then
    await assert.rejects(read(data));
  });
}

const partial = [
  ['missing rollup', (data) => { delete commit(data).statusCheckRollup; }],
  ['missing contexts', (data) => { commit(data).statusCheckRollup = {}; }],
  ['null contexts', (data) => { commit(data).statusCheckRollup.contexts = null; }],
  ['missing commit', (data) => { pull(data).commits.nodes = []; }],
  ['different head commit', (data) => { commit(data).oid = 'old-head'; }],
  ['missing threads', (data) => { delete pull(data).reviewThreads; }],
  ['missing reviews', (data) => { delete pull(data).reviews; }],
  ['missing comments', (data) => { delete pull(data).comments; }],
  ['null thread node', (data) => { pull(data).reviewThreads.nodes = [null]; }],
  ['missing nested comments', (data) => { delete pull(data).reviewThreads.nodes[0].comments; }],
  ['missing pageInfo', (data) => { delete pull(data).comments.pageInfo; }],
  ['missing nodes', (data) => { delete pull(data).comments.nodes; }],
  ['missing CI status', (data) => { delete commit(data).statusCheckRollup.contexts.nodes[0].status; }],
  ['missing thread resolution', (data) => { delete pull(data).reviewThreads.nodes[0].isResolved; }],
  ['missing PR state', (data) => { delete pull(data).state; }],
  ['GraphQL errors alongside data', (data) => { data.errors = [{ message: 'Partial response', path: ['repository'] }]; }],
];
for (const [name, change] of partial) {
  test(`rejects partial feedback with ${name}`, async () => {
    // Given
    const data = snapshot();
    change(data);
    // When / Then
    await assert.rejects(read(data));
  });
}

test('propagates a GraphQL rejection carrying partial data', async () => {
  // Given
  const error = Object.assign(new Error('GraphQL failed'), { data: snapshot() });
  const octokit = { graphql: async () => { throw error; } };
  // When / Then
  await assert.rejects(readPullFeedback({ octokit, owner: 'a', repo: 'b', number: 1 }), (actual) => actual === error);
});
