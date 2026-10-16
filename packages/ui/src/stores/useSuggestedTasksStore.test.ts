import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deferred, inbox, installSuggestedTasksDom, serveSuggestedTasks, suggestion } from '@/lib/test-utils/suggestedTasks.fixture';
import { useSuggestedTasksStore } from './useSuggestedTasksStore';
import { getSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let dom: ReturnType<typeof installSuggestedTasksDom>;

beforeEach(() => {
  dom = installSuggestedTasksDom();
  useSuggestedTasksStore.setState({ inboxes: {}, summary: null });
});
afterEach(async () => {
  await server?.stop(true);
  await dom.restore();
});

const currentInbox = () => {
  const entry = useSuggestedTasksStore.getState().inboxes.app;
  return entry && entry.status !== 'loading' ? entry.inbox : null;
};

describe('Suggested tasks inbox reconciliation', () => {
  test('keeps a completed approval when an older inbox read returns', async () => {
    // Given an inbox read that captured the open suggestion before approval.
    const started = deferred<void>();
    const response = deferred<Response>();
    let reads = 0;
    server = await serveSuggestedTasks(() => {
      if (++reads === 1) return Response.json(inbox([suggestion()]));
      started.resolve();
      return response.promise;
    });
    const store = useSuggestedTasksStore.getState();
    await store.loadInbox('app');
    const refresh = store.loadInbox('app');
    await started.promise;

    // When approval completes before that older read.
    store.applySuggestion('app', suggestion({ status: 'approved' }), getSuggestedTasksRuntime());
    response.resolve(Response.json(inbox([suggestion()])));
    await refresh;

    // Then the approved state remains visible.
    expect(currentInbox()?.suggestions[0]?.status).toBe('approved');
  });

  test('applies an action while a failed refresh keeps the last inbox visible', async () => {
    // Given a successful inbox followed by a failed refresh.
    let reads = 0;
    server = await serveSuggestedTasks(() => ++reads === 1
      ? Response.json(inbox([suggestion()]))
      : Response.json({ error: 'Offline' }, { status: 503 }));
    const store = useSuggestedTasksStore.getState();
    await store.loadInbox('app');
    await store.loadInbox('app');

    // When a dismissal succeeds independently of the failed refresh.
    store.applySuggestion('app', suggestion({ status: 'dismissed' }), getSuggestedTasksRuntime());

    // Then the card changes and the refresh failure remains visible.
    expect(currentInbox()?.suggestions[0]?.status).toBe('dismissed');
    expect(useSuggestedTasksStore.getState().inboxes.app.status).toBe('error');
  });

  test('coalesces refresh demand during an inbox read into one trailing read', async () => {
    // Given an inbox read still in flight.
    const started = deferred<void>();
    const response = deferred<Response>();
    let reads = 0;
    server = await serveSuggestedTasks(() => {
      if (++reads === 1) { started.resolve(); return response.promise; }
      return Response.json(inbox([suggestion({ title: 'New result' })]));
    });
    const store = useSuggestedTasksStore.getState();
    const first = store.loadInbox('app');
    await started.promise;

    // When two change notifications request freshness during that read.
    const second = store.loadInbox('app', true);
    const third = store.loadInbox('app', true);
    response.resolve(Response.json(inbox()));
    await Promise.all([first, second, third]);

    // Then one follow-up supplies the newest inbox.
    expect(reads).toBe(2);
    expect(currentInbox()?.suggestions[0]?.title).toBe('New result');
  });

  test('retains a successful summary when a later request fails', async () => {
    // Given confirmed nonzero counts.
    let reads = 0;
    server = await serveSuggestedTasks(() => ++reads === 1
      ? Response.json({ projects: [{ projectId: 'app', open: 3 }] })
      : Response.json({ error: 'Offline' }, { status: 503 }));
    const store = useSuggestedTasksStore.getState();
    await store.loadSummary();

    // When summary refresh fails.
    await store.loadSummary();

    // Then the last known count survives and the error remains available to the inbox.
    expect(useSuggestedTasksStore.getState().summary?.[0]?.open).toBe(3);
    expect(useSuggestedTasksStore.getState().summaryError).toBe('Offline');
  });

  test('rejects an older summary that returns after a newer summary', async () => {
    // Given a slow summary and a later independent summary.
    const started = deferred<void>();
    const response = deferred<Response>();
    let reads = 0;
    server = await serveSuggestedTasks(() => {
      if (++reads === 1) { started.resolve(); return response.promise; }
      return Response.json({ projects: [{ projectId: 'app', open: 1 }] });
    });
    const store = useSuggestedTasksStore.getState();
    const older = store.loadSummary();
    await started.promise;

    // When the new summary arrives first.
    await store.loadSummary();
    response.resolve(Response.json({ projects: [{ projectId: 'app', open: 4 }] }));
    await older;

    // Then the old count cannot overwrite it.
    expect(useSuggestedTasksStore.getState().summary?.[0]?.open).toBe(1);
  });

  test('rejects a completed mutation captured before an A to B to A runtime switch', async () => {
    // Given an action admitted in a previous runtime lifetime.
    server = await serveSuggestedTasks(() => Response.json(inbox([suggestion()])));
    const original = getSuggestedTasksRuntime();

    // When a new runtime lifetime reuses the same project and suggestion IDs.
    switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'other-runtime' });
    switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: `test-${server.port}` });
    await useSuggestedTasksStore.getState().loadInbox('app');
    useSuggestedTasksStore.getState().applySuggestion('app', suggestion({ status: 'approved' }), original);

    // Then the old action cannot mutate the new lifetime.
    expect(currentInbox()?.suggestions[0]?.status).toBe('open');
  });
});
