import { describe, expect, test } from 'bun:test';
import { DEFAULT_PR_FIX_LOOP_CONFIG, fixLoopSchema, prFixLoopUpdatedEventSchema, type FixLoop } from '@/lib/prFixLoop';
import type { PrFixLoopAPI } from '@/lib/prFixLoopApi';
import { createPrFixLoopProjection } from './prFixLoopProjection';

const loop = (fields: Partial<FixLoop> = {}): FixLoop => ({
  id: 'loop-1', sessionId: 'session-1', directory: '/project', owner: 'owner', repo: 'repo',
  number: 12, url: 'https://github.com/owner/repo/pull/12', title: 'Fix tests', branch: 'fix-tests',
  status: 'watching', statusReason: null, config: DEFAULT_PR_FIX_LOOP_CONFIG,
  iterations: 0, tokensUsed: 0, ci: null, unresolvedThreads: null, changesRequested: null,
  worker: null, pendingApproval: null, review: null, lastCheckedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
  ...fields,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise has not started'); };
  let reject: (error: Error) => void = () => { throw new Error('Promise has not started'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let runtime = 'a';
  const reads: ReturnType<typeof deferred<Awaited<ReturnType<PrFixLoopAPI['list']>>>>[] = [];
  const updates: ReturnType<typeof deferred<FixLoop>>[] = [];
  const api: PrFixLoopAPI = {
    list: () => {
      const read = deferred<Awaited<ReturnType<PrFixLoopAPI['list']>>>();
      reads.push(read);
      return read.promise;
    },
    create: async () => loop(),
    update: () => {
      const update = deferred<FixLoop>();
      updates.push(update);
      return update.promise;
    },
    stop: async () => loop({ status: 'stopped', updatedAt: 2 }),
    resume: async () => loop({ status: 'watching', updatedAt: 3 }),
    approve: async () => loop({ pendingApproval: null, updatedAt: 4 }),
    prepareWorker: async () => { throw new Error('Not used in projection'); },
    listWorkers: async () => [],
    forgetWorker: async () => undefined,
    dismiss: async () => undefined,
  };
  const store = createPrFixLoopProjection({ api, runtimeKey: () => runtime });
  const event = (value: FixLoop) => store.getState().applyEvent({
    type: 'openchamber:pr-fix-loop.updated', properties: { loop: value },
  }, runtime);
  const remove = (id: string) => store.getState().applyEvent({
    type: 'openchamber:pr-fix-loop.updated', properties: { id, removed: true },
  }, runtime);
  return { store, reads, updates, event, remove, switchTo: (key: string) => { runtime = key; store.getState().reset(); } };
}

describe('PR fix-loop projection', () => {
  test('keeps known loops when a snapshot fails', async () => {
    // Given
    const h = harness();
    h.event(loop());
    // When
    const read = h.store.getState().refresh();
    h.reads[0]?.reject(new Error('offline'));
    await read;
    // Then
    expect(h.store.getState().loops.map((entry) => entry.id)).toEqual(['loop-1']);
    expect(h.store.getState().loadState).toBe('error');
    expect(h.store.getState().loadError).toBe('offline');
  });

  test('accepts a successful empty snapshot', async () => {
    // Given
    const h = harness();
    h.event(loop());
    // When
    const read = h.store.getState().refresh();
    h.reads[0]?.resolve({ loops: [], rejectedIds: [] });
    await read;
    // Then
    expect(h.store.getState().loops).toEqual([]);
    expect(h.store.getState().loadState).toBe('ready');
  });

  test('overlays updates and creates received while a snapshot is in flight', async () => {
    // Given
    const h = harness();
    h.event(loop());
    const read = h.store.getState().refresh();
    // When
    h.event(loop({ status: 'working', updatedAt: 2 }));
    h.event(loop({ id: 'loop-2', number: 13 }));
    h.reads[0]?.resolve({ loops: [loop()], rejectedIds: [] });
    await read;
    // Then
    expect(h.store.getState().loops.map((entry) => [entry.id, entry.status])).toEqual([
      ['loop-1', 'working'], ['loop-2', 'watching'],
    ]);
  });

  test('a removal of an unseen loop prevents snapshot resurrection', async () => {
    // Given
    const h = harness();
    const read = h.store.getState().refresh();
    // When
    h.remove('loop-1');
    h.reads[0]?.resolve({ loops: [loop()], rejectedIds: [] });
    await read;
    // Then
    expect(h.store.getState().loops).toEqual([]);
  });

  test('a removed loop rejects a delayed mutation response', async () => {
    // Given
    const h = harness();
    h.event(loop());
    const update = h.store.getState().update('loop-1', { maxIterations: 20 });
    // When
    h.remove('loop-1');
    h.updates[0]?.resolve(loop({ updatedAt: 2 }));
    await update;
    // Then
    expect(h.store.getState().loops).toEqual([]);
  });

  test('snapshot omission rejects a delayed mutation response', async () => {
    // Given
    const h = harness();
    h.event(loop());
    const update = h.store.getState().update('loop-1', { maxIterations: 20 });
    const read = h.store.getState().refresh();
    h.reads[0]?.resolve({ loops: [], rejectedIds: [] });
    await read;
    // When
    h.updates[0]?.resolve(loop({ updatedAt: 2 }));
    await update;
    // Then
    expect(h.store.getState().loops).toEqual([]);
  });

  test('stale and duplicate events preserve unaffected references', () => {
    // Given
    const h = harness();
    h.event(loop({ updatedAt: 2 }));
    const before = h.store.getState().loops;
    // When
    h.event(loop({ updatedAt: 1, status: 'error' }));
    h.event(loop({ updatedAt: 2 }));
    // Then
    expect(h.store.getState().loops).toBe(before);
  });

  test('a GitHub read failure stays visible beside the retained CI sample', () => {
    // Given
    const h = harness();
    h.event(loop({ ci: { state: 'success', headSha: 'abc' }, updatedAt: 2 }));
    // When
    h.event(loop({ ci: { state: 'success', headSha: 'abc' }, lastError: 'GitHub unavailable', updatedAt: 3 }));
    // Then
    expect(h.store.getState().loops[0]?.lastError).toBe('GitHub unavailable');
    expect(h.store.getState().loops[0]?.ci?.state).toBe('success');
  });

  test('runtime switches reject old reads even after returning to the same key', async () => {
    // Given
    const h = harness();
    const read = h.store.getState().refresh();
    // When
    h.switchTo('b');
    h.switchTo('a');
    h.reads[0]?.resolve({ loops: [loop()], rejectedIds: [] });
    await read;
    // Then
    expect(h.store.getState().loops).toEqual([]);
    expect(h.store.getState().loadState).toBe('idle');
  });

  test('a reconnect during a read earns one trailing snapshot', async () => {
    // Given
    const h = harness();
    const read = h.store.getState().refresh();
    // When
    const reconnect = h.store.getState().refresh();
    h.store.getState().refresh();
    h.reads[0]?.resolve({ loops: [loop()], rejectedIds: [] });
    await Promise.resolve();
    h.reads[1]?.resolve({ loops: [loop({ status: 'ready', updatedAt: 3 })], rejectedIds: [] });
    await Promise.all([read, reconnect]);
    // Then
    expect(h.reads).toHaveLength(2);
    expect(h.store.getState().loops[0]?.status).toBe('ready');
  });

  test('a failed config write leaves the authoritative config intact', async () => {
    // Given
    const h = harness();
    h.event(loop());
    // When
    const update = h.store.getState().update('loop-1', { maxIterations: 20 });
    h.updates[0]?.reject(new Error('denied'));
    // Then
    await expect(update).rejects.toThrow('denied');
    expect(h.store.getState().loops[0]?.config.maxIterations).toBe(10);
  });

  test('rejects malformed external state rather than granting empty authority', () => {
    // Given
    const malformed = { ...loop(), config: { ...DEFAULT_PR_FIX_LOOP_CONFIG, maxIterations: 0 } };
    // When
    const response = fixLoopSchema.safeParse(malformed);
    const event = prFixLoopUpdatedEventSchema.safeParse({
      type: 'openchamber:pr-fix-loop.updated', properties: { loop: malformed },
    });
    // Then
    expect(response.success).toBe(false);
    expect(event.success).toBe(false);
  });

  test('retains a malformed loop while updating complete siblings', async () => {
    // Given
    const h = harness();
    h.event(loop());
    h.event(loop({ id: 'loop-2' }));
    // When
    const read = h.store.getState().refresh();
    h.reads[0]?.resolve({ loops: [loop({ id: 'loop-2', status: 'working', updatedAt: 2 })], rejectedIds: ['loop-1'] });
    await read;
    // Then
    expect(h.store.getState().loops.find((entry) => entry.id === 'loop-1')?.status).toBe('watching');
    expect(h.store.getState().loops.find((entry) => entry.id === 'loop-2')?.status).toBe('working');
    expect(h.store.getState().loadState).toBe('ready');
    expect(h.store.getState().failedLoopIds).toEqual(['loop-1']);
  });
});
