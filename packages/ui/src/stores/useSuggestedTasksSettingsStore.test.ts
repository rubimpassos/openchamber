import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { deferred, installSuggestedTasksDom, serveSuggestedTasks, settings } from '@/lib/test-utils/suggestedTasks.fixture';
import { useSuggestedTasksSettingsStore } from './useSuggestedTasksSettingsStore';

const flagsSchema = z.object({ config: z.object({ enabled: z.boolean(), notify: z.boolean(), archiveScanSessions: z.boolean() }) });
let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let dom: ReturnType<typeof installSuggestedTasksDom>;
beforeEach(() => { dom = installSuggestedTasksDom(); });
afterEach(async () => { await server?.stop(true); await dom.restore(); });
const store = () => useSuggestedTasksSettingsStore.getState();
const config = () => store().entries.app?.settings?.config;

describe('Suggested tasks settings ordering', () => {
  test('serializes rapid edits and keeps later optimistic values while an earlier save completes', async () => {
    // Given a first write whose response is held at the HTTP boundary.
    const started = deferred<void>();
    const response = deferred<void>();
    const writes: Array<z.infer<typeof flagsSchema>['config']> = [];
    server = await serveSuggestedTasks(async (request) => {
      if (request.method === 'GET') return Response.json(settings());
      const { config } = flagsSchema.parse(await request.json());
      writes.push(config);
      if (writes.length === 1) { started.resolve(); await response.promise; }
      return Response.json({ ...settings(), config: { ...settings().config, ...config } });
    });
    await store().load('app');
    const first = store().updateConfig('app', (current) => ({ ...current, notify: false }));
    await started.promise;

    // When another field is changed before the first save returns.
    const second = store().updateConfig('app', (current) => ({ ...current, archiveScanSessions: false }));
    expect(writes).toHaveLength(1);
    expect(config()?.archiveScanSessions).toBe(false);
    response.resolve();
    await Promise.all([first, second]);

    // Then both fields persist in order and the older echo cannot undo the later edit.
    expect(writes).toEqual([
      { enabled: true, notify: false, archiveScanSessions: true },
      { enabled: true, notify: false, archiveScanSessions: false },
    ]);
    expect(config()?.notify).toBe(false);
    expect(config()?.archiveScanSessions).toBe(false);
  });

  test('rolls back a failed edit without replaying it in a later successful edit', async () => {
    // Given two ordered edits with a rejected first write.
    const started = deferred<void>();
    const response = deferred<void>();
    const writes: Array<z.infer<typeof flagsSchema>['config']> = [];
    server = await serveSuggestedTasks(async (request) => {
      if (request.method === 'GET') return Response.json(settings());
      const { config } = flagsSchema.parse(await request.json());
      writes.push(config);
      if (writes.length === 1) {
        started.resolve(); await response.promise;
        return Response.json({ error: 'Disk full' }, { status: 500 });
      }
      return Response.json({ ...settings(), config: { ...settings().config, ...config } });
    });
    await store().load('app');
    const first = store().updateConfig('app', (current) => ({ ...current, notify: false }));
    await started.promise;

    // When a later archive edit survives that failure.
    const second = store().updateConfig('app', (current) => ({ ...current, archiveScanSessions: false }));
    response.resolve();
    expect(await Promise.all([first, second])).toEqual([false, true]);

    // Then only the successful archive edit reaches the confirmed config.
    expect(writes[1]).toEqual({ enabled: true, notify: true, archiveScanSessions: false });
    expect(config()?.notify).toBe(true);
    expect(config()?.archiveScanSessions).toBe(false);
  });

  test('preserves a completed mutation when a read started before it returns', async () => {
    // Given an older settings read in flight.
    const started = deferred<void>();
    const response = deferred<Response>();
    let reads = 0;
    server = await serveSuggestedTasks(async (request) => {
      if (request.method === 'GET') {
        if (++reads === 1) return Response.json(settings());
        started.resolve(); return response.promise;
      }
      const { config } = flagsSchema.parse(await request.json());
      return Response.json({ ...settings(), config: { ...settings().config, ...config } });
    });
    await store().load('app');
    const read = store().load('app');
    await started.promise;

    // When a newer save completes before that read.
    await store().updateConfig('app', (current) => ({ ...current, enabled: false }));
    response.resolve(Response.json(settings()));
    await read;

    // Then the saved disabled state remains authoritative.
    expect(config()?.enabled).toBe(false);
  });

  test('orders repository-lens writes with config edits without restoring an older config', async () => {
    // Given a repository-lens acknowledgement still in flight.
    const started = deferred<void>();
    const response = deferred<void>();
    server = await serveSuggestedTasks(async (request) => {
      if (request.method === 'GET') return Response.json(settings());
      if (new URL(request.url).pathname.endsWith('/repo-lenses')) {
        started.resolve(); await response.promise;
        return Response.json({ ...settings(), repoLenses: [{ ...settings().repoLenses[0], status: 'enabled' }] });
      }
      const { config } = flagsSchema.parse(await request.json());
      return Response.json({ ...settings(), config: { ...settings().config, ...config }, repoLenses: [{ ...settings().repoLenses[0], status: 'enabled' }] });
    });
    await store().load('app');
    const lens = store().setRepositoryLens('app', 'review.md', true);
    await started.promise;

    // When a config change follows that acknowledgement.
    const edit = store().updateConfig('app', (current) => ({ ...current, notify: false }));
    response.resolve();
    await Promise.all([lens, edit]);

    // Then the lens stays enabled and the later config change survives.
    expect(store().entries.app.settings?.repoLenses[0]?.status).toBe('enabled');
    expect(config()?.notify).toBe(false);
  });

  test('keeps a failed read visible without replacing the confirmed settings', async () => {
    // Given previously confirmed settings.
    let reads = 0;
    server = await serveSuggestedTasks(() => ++reads === 1 ? Response.json(settings()) : Response.json({ error: 'Offline' }, { status: 503 }));
    await store().load('app');

    // When the refresh fails.
    await store().load('app');

    // Then the prior config and the failure are both retained.
    expect(config()?.enabled).toBe(true);
    expect(store().entries.app.error).toBe('Offline');
  });

  test('cancels queued writes across an A to B to A runtime switch', async () => {
    // Given a write in flight with another edit queued behind it.
    const started = deferred<void>();
    const response = deferred<void>();
    let writes = 0;
    server = await serveSuggestedTasks(async (request) => {
      if (request.method === 'GET') return Response.json(settings());
      writes += 1;
      started.resolve(); await response.promise;
      return Response.json({ ...settings(), config: { ...settings().config, enabled: false } });
    });
    await store().load('app');
    const first = store().updateConfig('app', (current) => ({ ...current, enabled: false }));
    await started.promise;
    const second = store().updateConfig('app', (current) => ({ ...current, notify: false }));

    // When the user leaves the runtime and returns before the response arrives.
    switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'other-runtime' });
    switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: `test-${server.port}` });
    await store().load('app');
    response.resolve();
    await Promise.all([first, second]);

    // Then the queued write was never dispatched and the new visit keeps its own snapshot.
    expect(writes).toBe(1);
    expect(config()?.enabled).toBe(true);
    expect(config()?.notify).toBe(true);
    expect(store().entries.app.saving).toBe(false);
  });
});
