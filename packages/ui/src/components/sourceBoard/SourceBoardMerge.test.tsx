import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  ChangeRequestMergeOptions,
  MergeChangeRequestInput,
  RepositoryChangeRequestReference,
  RuntimeAPIs,
  SourceControlCapabilities,
  SourceControlReadContext,
} from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  PointerEvent: browser.PointerEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The components' imports pull in app stores that load on import; their requests never answer.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);
// The actions read the open chat's session; none is open here.
const syncContext = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({ ...syncContext, useSession: () => undefined }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // The method remembered from other repositories is one this one refuses.
  localStorage.setItem('openchamber:pr-merge-method:v1', 'squash');
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo-1',
  accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};
const pull: RepositoryChangeRequestReference = {
  kind: 'pull', provider: 'github', number: 12, title: 'Login flow', url: 'https://example.com/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'f'.repeat(40), headRepo: null,
};

const capabilities: SourceControlCapabilities = {
  identity: { provider: 'github', instance: 'github.com' },
  authentication: true,
  authenticationMethods: { device: { available: false }, pat: { available: true }, cli: { available: false } },
  multipleAccounts: true,
  projects: true, issues: true, changeRequests: true, draftChangeRequests: true, draftConversion: true,
  mergeChangeRequests: true, mergeMethods: ['merge', 'squash', 'rebase'], ci: true,
};

const renderActions = async (mergeOptions: ChangeRequestMergeOptions) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SourceBoardActions } = await import('./SourceBoardActions');
  const ordered = [githubLikeDescriptor()];
  useSourceControlProviderRegistry.setState({ ordered, byId: new Map(ordered.map((entry) => [entry.id, entry])), status: 'ready', holdsList: true });
  const sent: MergeChangeRequestInput[] = [];
  const base = createWebAPIs();
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      capabilities: async () => capabilities,
      changeRequestMerge: async (input) => {
        sent.push(input);
        return { status: 'succeeded', replayed: false, result: { merged: false, outcome: 'auto-merge' }, actor: { provider: input.provider, instance: input.instance, providerAccountId: 'github.com#7' }, target: { repositoryId: input.repositoryId, bindingRevision: input.bindingRevision, primaryRemote: input.primaryRemote, project: { id: '1', owner: 'acme', name: 'app' } } };
      },
    },
  };
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <SourceBoardActions item={{ source: 'repository', reference: pull }} project={null} context={context}
            onStartWorktree={() => undefined} onChanged={() => undefined} worktreeAvailable={false} mergeOptions={mergeOptions} />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
  return sent;
};

const button = (label: string) => {
  // The confirmation's button comes after the control that opened it.
  const element = [...document.querySelectorAll<HTMLElement>('button')].reverse().find((node) => node.textContent?.trim() === label);
  if (!element) throw new Error(`Expected a ${label} button; found ${[...document.querySelectorAll('button')].map((node) => node.textContent?.trim()).join(' | ')}`);
  return element;
};
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
const openMethods = async () => {
  const trigger = document.querySelector<HTMLElement>('[aria-label="Merge method"]');
  if (!trigger) throw new Error('Expected the method menu');
  await click(trigger);
  return [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent?.trim() ?? '');
};

describe('merging a pull request the repository restricts', () => {
  test('offers only the methods the repository allows, whatever was remembered', async () => {
    await renderActions({ methods: ['rebase'], queue: null, canBypass: false });
    expect(button('Rebase and merge')).toBeTruthy();
    expect(document.querySelector('[aria-label="Merge method"]')).toBeNull();
  });

  test('a merge queue branch merges when ready, through the queue', async () => {
    const sent = await renderActions({ methods: ['rebase'], queue: { method: 'rebase' }, canBypass: false });
    expect(document.querySelector('[aria-label="Merge method"]')).toBeNull();
    await click(button('Merge when ready'));
    await click(button('Merge when ready'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'rebase', action: 'queue', target: { number: 12, headSha: 'f'.repeat(40) } });
  });

  test('someone who may bypass the rules can merge now with an allowed method', async () => {
    const sent = await renderActions({ methods: ['rebase'], queue: { method: 'rebase' }, canBypass: true });
    expect(await openMethods()).toEqual(['Merge when ready', 'Rebase and merge now, bypassing rules']);
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((node) => node.textContent?.includes('bypassing'));
    if (!item) throw new Error('Expected the bypass item');
    await click(item);
    await click(button('Rebase and merge now, bypassing rules'));
    expect(document.body.textContent).toContain('This skips the merge queue and the branch rules and merges now.');
    await click(button('Merge'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'rebase', action: 'direct' });
  });
});
