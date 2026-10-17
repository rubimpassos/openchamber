import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';

import { createSessionKnowledgeRuntime } from './runtime.js';
import { registerSessionKnowledgeRoutes } from './routes.js';
import { createFollowedPullStackContext } from './pull-stacks.js';

const DIRECTORY = '/work/project';
const snapshot = (members) => ({
  anchor: { owner: 'acme', repo: 'app', number: 1 },
  status: 'available',
  stack: { source: 'inferred', trunk: 'main', members, branches: [], nativeUnavailable: false },
});
const member = (number, head, base, state = 'open') => ({ number, head, base, state });

const fixture = () => {
  let metadata = { openchamber: { project_context_pins: { notes: ['n1'], plans: [] } } };
  let stacks = [snapshot([member(1, 'first', 'main'), member(2, 'second', 'first')])];
  const collectFollowedPullStacks = createFollowedPullStackContext({
    readBinding: async () => ({
      repository: { repositoryId: 'repo_1', remotes: [{ name: 'upstream', fetch: { fingerprint: 'fp' } }] },
      revision: 3,
      binding: { providers: [{ provider: 'github', instance: 'github.com', accountId: 'bound', primaryRemote: 'upstream', readiness: 'ready', endpoint: { fingerprint: 'fp' } }] },
    }),
    readPullStack: async ({ number }) => {
      const current = stacks.find((entry) => entry.anchor.number === number);
      if (current.status === 'unavailable') throw new Error('Provider failed');
      return current.stack;
    },
  });
  const setStacks = (next) => {
    stacks = next;
    metadata.openchamber.linked_issues = next.map(({ anchor }) => ({
      kind: 'pull', followStack: true, number: anchor.number, url: `https://github.com/${anchor.owner}/${anchor.repo}/pull/${anchor.number}`,
    }));
  };
  setStacks(stacks);
  const runtime = createSessionKnowledgeRuntime({
    resolveProjectId: async () => 'project',
    projectContextRuntime: { readContext: async () => ({ notes: [{ id: 'n1', body: 'Project fact', createdAt: 1, updatedAt: 1 }], plans: [] }) },
    isAgentMemoryEnabled: async () => false,
    readSessionMetadata: async () => metadata,
    persistSessionMetadata: async (_id, _directory, patch) => {
      metadata = { ...metadata, openchamber: { ...metadata.openchamber, ...patch.openchamber } };
    },
    collectFollowedPullStacks,
  });
  const app = express();
  registerSessionKnowledgeRoutes(app, { sessionKnowledgeRuntime: runtime });
  return {
    runtime,
    setStacks,
    pending: () => request(app).get('/api/session-knowledge').query({ sessionId: 'ses_1', directory: DIRECTORY }),
    delivered: (signature) => request(app).post('/api/session-knowledge/delivered').send({ sessionId: 'ses_1', directory: DIRECTORY, signature }),
  };
};

const stackData = (text) => JSON.parse(text.split('<openchamber-pull-stacks>\n')[1].split('\n</openchamber-pull-stacks>')[0]);

describe('followed stack context through the session knowledge HTTP routes', () => {
  test('delivers changed membership on the next turn when the anchor remains linked', async () => {
    // Given a session that has received its original stack.
    const driver = fixture();
    const first = (await driver.pending()).body;
    await driver.delivered(first.signature);
    driver.setStacks([snapshot([member(1, 'first', 'main', 'merged'), member(3, 'third', 'main')])]);

    // When a later turn asks for its pending context.
    const next = await driver.pending();

    // Then the complete replacement membership and current branches reach it.
    expect(next.status).toBe(200);
    expect(stackData(next.body.text)[0].stack.members).toEqual([member(1, 'first', 'main', 'merged'), member(3, 'third', 'main')]);
    expect(next.body.signature).not.toBe(first.signature);
  });

  test('deduplicates unchanged context when delivery has been accepted', async () => {
    // Given a delivered stack snapshot.
    const driver = fixture();
    const first = (await driver.pending()).body;
    await driver.delivered(first.signature);

    // When another turn resolves the same snapshot.
    const next = await driver.pending();

    // Then it owes no context.
    expect(next.body).toEqual({ text: '', signature: first.signature });
  });

  test('keeps context pending when a send never records delivery', async () => {
    // Given a snapshot whose first attempted send was not accepted.
    const driver = fixture();
    const first = (await driver.pending()).body;

    // When the caller retries without recording delivery.
    const retry = await driver.pending();

    // Then it still receives that complete snapshot.
    expect(stackData(retry.body.text)[0].stack.members).toHaveLength(2);
    expect(retry.body.signature).toBe(first.signature);
  });

  test('delivers a changed status when membership stays the same', async () => {
    // Given the old stack has been delivered.
    const driver = fixture();
    const first = (await driver.pending()).body;
    await driver.delivered(first.signature);
    driver.setStacks([snapshot([member(1, 'first', 'main'), { ...member(2, 'renamed', 'main'), checks: { failed: 1 }, summary: 'ok' }])]);

    // When a turn asks after a branch and CI change.
    const next = await driver.pending();

    // Then the current branch and failed CI are delivered.
    expect(stackData(next.body.text)[0].stack.members[1]).toMatchObject({ head: 'renamed', base: 'main', checks: { failed: 1 } });
    expect(next.body.signature).not.toBe(first.signature);
  });

  test('restores the same snapshot when compaction invalidates delivery', async () => {
    // Given context already recorded as delivered.
    const driver = fixture();
    const first = (await driver.pending()).body;
    await driver.delivered(first.signature);

    // When compaction requests a fresh delivery.
    const restored = await driver.runtime.resolvePendingForSession('ses_1', DIRECTORY, { force: true });

    // Then the stack is included even though its data has not changed.
    expect(stackData(restored.text)[0].stack.members).toHaveLength(2);
    expect(restored.signature).toBe(first.signature);
  });

  test('keeps successful siblings and pinned knowledge when one stack read fails', async () => {
    // Given one unreadable anchor alongside a complete stack.
    const driver = fixture();
    driver.setStacks([
      { anchor: { owner: 'acme', repo: 'app', number: 9 }, status: 'unavailable', reason: 'read-failed' },
      snapshot([member(1, 'first', 'main'), member(2, 'second', 'first')]),
    ]);

    // When a turn resolves its context.
    const result = await driver.pending();

    // Then failure remains distinct from an authoritative unstacked response.
    const data = stackData(result.body.text);
    const failed = data.find((entry) => entry.anchor.number === 9);
    expect(failed).toMatchObject({ status: 'unavailable', reason: 'read-failed' });
    expect(failed).not.toHaveProperty('stack');
    expect(data.find((entry) => entry.anchor.number === 1).stack.members).toHaveLength(2);
    expect(result.body.text).toContain('Project fact');
  });

  test('marks context unavailable when the linked-anchor metadata cannot be read', async () => {
    // Given an unreadable session record.
    const runtime = createSessionKnowledgeRuntime({
      readSessionMetadata: async () => { throw new Error('metadata unavailable'); },
    });
    const app = express();
    registerSessionKnowledgeRoutes(app, { sessionKnowledgeRuntime: runtime });

    // When a sender asks for the session's pending context.
    const result = await request(app).get('/api/session-knowledge').query({ sessionId: 'ses_1', directory: DIRECTORY });

    // Then the existing route reports failure rather than successful emptiness.
    expect(result.body.unavailable).toBe(true);
  });
});
