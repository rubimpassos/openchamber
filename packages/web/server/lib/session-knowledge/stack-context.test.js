import { describe, expect, test } from 'bun:test';
import express from 'express';
import request from 'supertest';

import { KNOWLEDGE_ENTRY_KEYS, buildKnowledgeEntries, createSessionKnowledgeRuntime } from './runtime.js';
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
  const held = new Map();
  let failWrite = false;
  const instructionEntries = {
    put: async (_sessionId, _directory, key, value) => {
      if (failWrite && key === KNOWLEDGE_ENTRY_KEYS.pullStacks) throw new Error('entry unavailable');
      held.set(key, value);
    },
    remove: async (_sessionId, _directory, key) => { held.delete(key); },
  };
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
    instructionEntries,
  });
  const app = express();
  registerSessionKnowledgeRoutes(app, { sessionKnowledgeRuntime: runtime });
  return {
    runtime,
    setStacks,
    held,
    failWrite: (value) => { failWrite = value; },
    text: () => held.get(KNOWLEDGE_ENTRY_KEYS.pullStacks),
    sync: () => request(app).post('/api/session-knowledge/sync').send({ sessionId: 'ses_1', directory: DIRECTORY }),
  };
};

const stackData = (text) => JSON.parse(text.split('<openchamber-pull-stacks>\n')[1].split('\n</openchamber-pull-stacks>')[0]);

describe('followed stack context through the session knowledge HTTP routes', () => {
  test('keeps complete stack JSON beside a pinned plan over its text budget', () => {
    const members = Array.from({ length: 150 }, (_, index) => member(index + 1, `branch-${index}`, 'main'));
    const entries = buildKnowledgeEntries({
      notes: [], plans: [{ title: 'Long plan', body: 'x'.repeat(12_000) }],
      memory: { global: [], project: [] }, pullStacks: [snapshot(members)],
    });
    expect(entries[KNOWLEDGE_ENTRY_KEYS.pinned]).toContain('(truncated)');
    expect(stackData(entries[KNOWLEDGE_ENTRY_KEYS.pullStacks])[0].stack.members).toEqual(members);
  });

  test('preserves the previous stack entry on collection failure while syncing pinned knowledge', async () => {
    const held = new Map([[KNOWLEDGE_ENTRY_KEYS.pullStacks, 'previous snapshot']]);
    const runtime = createSessionKnowledgeRuntime({
      resolveProjectId: async () => 'project',
      readSessionMetadata: async () => ({ openchamber: { project_context_pins: { notes: ['n1'] } } }),
      projectContextRuntime: { readContext: async () => ({ notes: [{ id: 'n1', body: 'Project fact', createdAt: 1 }] }) },
      isAgentMemoryEnabled: async () => false,
      collectFollowedPullStacks: async () => { throw new Error('collection failed'); },
      instructionEntries: {
        put: async (_id, _directory, key, value) => { held.set(key, value); },
        remove: async (_id, _directory, key) => { held.delete(key); },
      },
    });
    await runtime.sync('ses_1', DIRECTORY);
    expect(held.get(KNOWLEDGE_ENTRY_KEYS.pullStacks)).toBe('previous snapshot');
    expect(held.get(KNOWLEDGE_ENTRY_KEYS.pinned)).toContain('Project fact');
  });
  test('delivers changed membership on the next turn when the anchor remains linked', async () => {
    // Given a session that has received its original stack.
    const driver = fixture();
    await driver.sync();
    const first = driver.text();
    driver.setStacks([snapshot([member(1, 'first', 'main', 'merged'), member(3, 'third', 'main')])]);

    // When a later turn asks for its pending context.
    const next = await driver.sync();

    // Then the complete replacement membership and current branches reach it.
    expect(next.status).toBe(200);
    expect(next.body.synced).toBe(true);
    expect(stackData(driver.text())[0].stack.members).toEqual([member(1, 'first', 'main', 'merged'), member(3, 'third', 'main')]);
    expect(driver.text()).not.toBe(first);
  });

  test('writes identical entries for OpenCode to deduplicate unchanged context', async () => {
    // Given a delivered stack snapshot.
    const driver = fixture();
    await driver.sync();
    const first = driver.text();

    // When another turn resolves the same snapshot.
    const next = await driver.sync();

    // Then OpenCode receives the same value and announces no change.
    expect(next.body).toEqual({ synced: true });
    expect(driver.text()).toBe(first);
  });

  test('retries a failed instruction write on the next send', async () => {
    // Given a snapshot whose first attempted send was not accepted.
    const driver = fixture();
    driver.failWrite(true);
    expect((await driver.sync()).body.synced).toBe(false);
    expect(driver.text()).toBeUndefined();

    // When the caller retries without recording delivery.
    driver.failWrite(false);
    const retry = await driver.sync();

    // Then it still receives that complete snapshot.
    expect(retry.body.synced).toBe(true);
    expect(stackData(driver.text())[0].stack.members).toHaveLength(2);
  });

  test('delivers a changed status when membership stays the same', async () => {
    // Given the old stack has been delivered.
    const driver = fixture();
    await driver.sync();
    const first = driver.text();
    driver.setStacks([snapshot([member(1, 'first', 'main'), { ...member(2, 'renamed', 'main'), checks: { failed: 1 }, summary: 'ok' }])]);

    // When a turn asks after a branch and CI change.
    await driver.sync();

    // Then the current branch and failed CI are delivered.
    expect(stackData(driver.text())[0].stack.members[1]).toMatchObject({ head: 'renamed', base: 'main', checks: { failed: 1 } });
    expect(driver.text()).not.toBe(first);
  });

  test('removes the stack entry after the last followed anchor is unlinked', async () => {
    // Given context already recorded as delivered.
    const driver = fixture();
    await driver.sync();
    expect(stackData(driver.text())[0].stack.members).toHaveLength(2);

    // When the next send has no followed anchors.
    driver.setStacks([]);
    await driver.sync();

    // Then the old snapshot is explicitly removed.
    expect(driver.text()).toBeUndefined();
  });

  test('keeps successful siblings and pinned knowledge when one stack read fails', async () => {
    // Given one unreadable anchor alongside a complete stack.
    const driver = fixture();
    driver.setStacks([
      { anchor: { owner: 'acme', repo: 'app', number: 9 }, status: 'unavailable', reason: 'read-failed' },
      snapshot([member(1, 'first', 'main'), member(2, 'second', 'first')]),
    ]);

    // When a turn resolves its context.
    const result = await driver.sync();

    // Then failure remains distinct from an authoritative unstacked response.
    expect(result.body.synced).toBe(true);
    const data = stackData(driver.text());
    const failed = data.find((entry) => entry.anchor.number === 9);
    expect(failed).toMatchObject({ status: 'unavailable', reason: 'read-failed' });
    expect(failed).not.toHaveProperty('stack');
    expect(data.find((entry) => entry.anchor.number === 1).stack.members).toHaveLength(2);
    expect(driver.held.get(KNOWLEDGE_ENTRY_KEYS.pinned)).toContain('Project fact');
  });

  test('marks context unavailable when the linked-anchor metadata cannot be read', async () => {
    // Given an unreadable session record.
    let writes = 0;
    const runtime = createSessionKnowledgeRuntime({
      readSessionMetadata: async () => { throw new Error('metadata unavailable'); },
      instructionEntries: {
        put: async () => { writes += 1; },
        remove: async () => { writes += 1; },
      },
    });
    const app = express();
    registerSessionKnowledgeRoutes(app, { sessionKnowledgeRuntime: runtime });

    // When a sender asks for the session's pending context.
    const result = await request(app).post('/api/session-knowledge/sync').send({ sessionId: 'ses_1', directory: DIRECTORY });

    // Then the existing route reports failure rather than successful emptiness.
    expect(result.body.synced).toBe(false);
    expect(writes).toBe(0);
  });
});
