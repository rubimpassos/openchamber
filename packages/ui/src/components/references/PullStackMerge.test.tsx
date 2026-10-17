import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SourceControlReadContext } from '@/lib/api/types';
import { stackFixture, stackMember } from '@/lib/source-control/pullStack.test-support';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  // Imports may initialize unrelated app stores. Never send their requests to a live runtime.
  fetch: Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch),
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { PullStackMerge } = await import('./PullStackMerge');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
const { toast } = await import('@/components/ui');
const { createWebAPIs } = await import('../../../../web/src/api/index');
const { createWebSourceControlAPI } = await import('../../../../web/src/api/source-control');

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo-id',
  accountId: 'account-id', bindingRevision: 4, primaryRemote: 'origin',
};
const pull = { owner: 'acme', repo: 'app', number: 2 };
const stack = { ...stackFixture(), source: 'native' as const, nativeNumber: 1, members: [stackMember(1, { summary: 'ok' }), stackMember(2)] };
const receipt = <T,>(result: T) => ({ status: 'succeeded', replayed: false,
  actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#1' },
  target: { repositoryId: context.repositoryId, bindingRevision: context.bindingRevision, primaryRemote: context.primaryRemote,
    project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 1, headSha: stack.members[0].headSha }, result,
});
const apis = createWebAPIs();
let root: Root;
let host: HTMLDivElement;
const notices = {
  success: spyOn(toast, 'success'),
  info: spyOn(toast, 'info'),
  error: spyOn(toast, 'error'),
};

beforeEach(() => {
  for (const notice of Object.values(notices)) notice.mockReset().mockReturnValue('notice');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
afterAll(async () => {
  for (const notice of Object.values(notices)) notice.mockRestore();
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function renderMerge(response: Response) {
  let changedCount = 0;
  const changed = () => { changedCount += 1; };
  const sourceControl = createWebSourceControlAPI({ fetch: async (path) => {
    switch (path) {
      case '/api/source-control/github/capabilities':
        return Response.json({ identity: context, mergeChangeRequests: true, mergeMethods: ['squash'] });
      case '/api/source-control/github/pulls/stack/merge':
        return response;
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  } });
  await act(async () => root.render(
    <I18nProvider><RuntimeAPIContext.Provider value={{ ...apis, sourceControl }}>
      <PullStackMerge context={context} stack={stack} pull={pull} onChanged={changed} />
    </RuntimeAPIContext.Provider></I18nProvider>,
  ));
  const trigger = host.querySelector('button');
  if (!trigger || trigger.disabled) throw new Error('Merge action is unavailable');
  await act(async () => trigger.click());
  const approve = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent === 'Merge bottom PR #1');
  if (!approve) throw new Error('Merge confirmation is unavailable');
  return { approve, changedCount: () => changedCount };
}

for (const outcome of [
  { status: 'merged', merged: true, feedback: 'success', message: '#1 merged' },
  { status: 'enqueued', merged: false, feedback: 'info', message: '#1 added to the merge queue' },
  { status: 'pending', merged: false, feedback: 'info', message: 'Merge pending for #1' },
] as const) test(`refreshes the stack with accurate feedback when the merge is ${outcome.status}`, async () => {
  // Given
  const { approve, changedCount } = await renderMerge(Response.json(receipt({ ok: true, status: outcome.status, merged: outcome.merged, retargeted: null })));

  // When
  await act(async () => approve.click());

  // Then
  expect(changedCount()).toBe(1);
  expect(notices[outcome.feedback].mock.calls[0]).toEqual([outcome.message]);
  expect(notices.success.mock.calls).toHaveLength(outcome.merged ? 1 : 0);
  expect(notices.info.mock.calls).toHaveLength(outcome.merged ? 0 : 1);
  expect(notices.error.mock.calls).toHaveLength(0);
});

for (const { name, payload, status } of [
  { name: 'refused', payload: { error: 'Binding changed', code: 'STALE_BINDING' }, status: 409 },
  { name: 'malformed', payload: { ok: true, status: 'pending', merged: true, retargeted: null }, status: 200 },
]) test(`keeps merge failure distinct when the response is ${name}`, async () => {
  // Given
  const { approve, changedCount } = await renderMerge(Response.json(status === 200 ? receipt(payload) : payload, { status }));

  // When
  await act(async () => approve.click());

  // Then
  expect(changedCount()).toBe(0);
  expect(notices.error.mock.calls).toHaveLength(1);
  expect(notices.success.mock.calls).toHaveLength(0);
  expect(notices.info.mock.calls).toHaveLength(0);
});
