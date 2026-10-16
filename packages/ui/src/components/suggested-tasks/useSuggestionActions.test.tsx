import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { deferred, inbox, installSuggestedTasksDom, serveSuggestedTasks, suggestion } from '@/lib/test-utils/suggestedTasks.fixture';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const dom = installSuggestedTasksDom();
const bootstrapServer = await serveSuggestedTasks(() => Response.json({}));
const { I18nProvider } = await import('@/lib/i18n');
const { useSuggestionActions } = await import('./useSuggestionActions');
const { useSuggestedTasksStore } = await import('@/stores/useSuggestedTasksStore');
const { DismissSuggestionDialog } = await import('./DismissSuggestionDialog');

let root: Root;
let server: Awaited<ReturnType<typeof serveSuggestedTasks>> | undefined;
let capturedActions: ReturnType<typeof useSuggestionActions> | undefined;
const leaves: string[] = [];
const Harness = ({ id }: { id: string }) => {
  capturedActions = useSuggestionActions({ id, path: `/repo/${id}` }, (reason) => leaves.push(reason));
  return null;
};
const render = (id: string) => act(async () => root.render(<I18nProvider><Harness key={id} id={id} /></I18nProvider>));
beforeEach(() => {
  server = undefined;
  root = createRoot(document.body.appendChild(document.createElement('div')));
  leaves.length = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  await server?.stop(true);
  document.body.replaceChildren();
});
afterAll(async () => { await bootstrapServer.stop(true); await dom.restore(); });

describe('Suggestion action ownership', () => {
  test('updates the original inbox without navigating a different project visit', async () => {
    // Given a session approval started in project A.
    const started = deferred<void>();
    const response = deferred<Response>();
    server = await serveSuggestedTasks((request) => {
      if (request.method === 'GET') return Response.json(inbox([suggestion()]));
      started.resolve(); return response.promise;
    });
    await useSuggestedTasksStore.getState().loadInbox('a');
    await render('a');
    let operation: Promise<void> | undefined;
    await act(async () => {
      operation = capturedActions?.decide(suggestion(), { kind: 'approve', action: 'session' });
      await started.promise;
    });

    // When project B replaces the visit before approval finishes.
    await render('b');
    response.resolve(Response.json({ suggestion: suggestion({ status: 'approved', conversion: { kind: 'session', sessionId: 'session-a', directory: '/repo/a' } }) }));
    await act(async () => { await operation; });

    // Then project A's cache records the approval and project B stays on screen.
    const entry = useSuggestedTasksStore.getState().inboxes.a;
    expect(entry?.status === 'ready' && entry.inbox.suggestions[0]?.status).toBe('approved');
    expect(leaves).toEqual([]);
  });

  test('does not apply an old approval after the runtime leaves and returns', async () => {
    // Given an approval whose response belongs to a retired runtime lifetime.
    const started = deferred<void>();
    const response = deferred<Response>();
    server = await serveSuggestedTasks((request) => {
      if (request.method === 'GET') return Response.json(inbox([suggestion()]));
      started.resolve(); return response.promise;
    });
    await useSuggestedTasksStore.getState().loadInbox('a');
    await render('a');
    let operation: Promise<void> | undefined;
    await act(async () => {
      operation = capturedActions?.decide(suggestion(), { kind: 'approve', action: 'session' });
      await started.promise;
    });

    // When A to B to A creates a new inbox with the same project and suggestion IDs.
    switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'other-runtime' });
    switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: `test-${server.port}` });
    await useSuggestedTasksStore.getState().loadInbox('a');
    response.resolve(Response.json({ suggestion: suggestion({ status: 'approved', conversion: { kind: 'session', sessionId: 'old-session' } }) }));
    await act(async () => { await operation; });

    // Then the old response cannot approve the new runtime's card or navigate it.
    const entry = useSuggestedTasksStore.getState().inboxes.a;
    expect(entry?.status === 'ready' && entry.inbox.suggestions[0]?.status).toBe('open');
    expect(leaves).toEqual([]);
  });

  test('keeps the dismissal dialog open and retryable after a rejected dismissal', async () => {
    // Given a dialog whose dismissal failed and has already reported that failure.
    const closes: boolean[] = [];
    await act(async () => root.render(<I18nProvider><DismissSuggestionDialog title="Check input" onOpenChange={(open) => closes.push(open)} onDismiss={async () => false} /></I18nProvider>));
    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Dismiss');
    if (!confirm) throw new Error('Missing confirmation');

    // When the user submits.
    await act(async () => confirm.click());

    // Then the rejection is handled without an unhandled promise or a successful close.
    expect(closes).toEqual([]);
    expect(confirm.disabled).toBe(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
