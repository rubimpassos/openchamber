import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { McpDraft } from '@/stores/useMcpConfigStore';
import { dict } from '@/lib/i18n/messages/en';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLButtonElement: browser.HTMLButtonElement, ShadowRoot: browser.ShadowRoot,
  DocumentFragment: browser.DocumentFragment, KeyboardEvent: browser.KeyboardEvent,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// Import-time Settings reads must preserve the project used by this scenario.
const projectSettings = { home: '/test', projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' };
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(projectSettings));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { McpPage } = await import('./McpPage');
const initialConfigState = useMcpConfigStore.getState();
const initialRuntimeState = useMcpStore.getState();
const container = document.createElement('div');
document.body.appendChild(container);
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  root = createRoot(container);
  useMcpConfigStore.setState(initialConfigState);
  useMcpStore.setState({ ...initialRuntimeState, refresh: async () => {} });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' });
});
afterEach(async () => { await act(async () => root.unmount()); });
afterAll(() => { fetchSpy.mockRestore(); browser.close(); });

/** DOM click() omits the hover and pointer events that Base UI uses for selection. */
const clickWithPointer = async (target: HTMLElement, pointerType: 'mouse' | 'touch') => {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }));
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType }));
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    if (pointerType === 'mouse') target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  if (pointerType === 'mouse' && target.getAttribute('role') === 'option') {
    expect(target.hasAttribute('data-highlighted')).toBe(true);
  }
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType, button: 0, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
    // The shared select opens from mousedown on its next animation frame.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType, button: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
  });
};

for (const pointerType of ['mouse', 'touch'] as const) {
  test(`selecting Local project with ${pointerType} creates through the real store with local scope`, async () => {
    // Given a Global draft so ignoring the selection would send the wrong owner.
    const draft: McpDraft = {
      name: 'scope-pointer-probe', scope: 'user', type: 'remote', command: [], url: 'https://mcp.test',
      environment: [], headers: [], oauthEnabled: false, oauthClientId: '', oauthClientSecret: '',
      oauthScope: '', oauthRedirectUri: '', oauthCallbackPort: '', oauthAuthServerMetadataUrl: '',
      protocol: 'legacy', timeoutStartup: '', timeoutCatalog: '', timeoutExecution: '', codemode: 'default', disabled: false,
    };
    const posts: Request[] = [];
    let markCapabilityConsumed = () => {};
    const capabilityConsumed = new Promise<void>((resolve) => { markCapabilityConsumed = resolve; });
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
      const path = new URL(request.url).pathname;
      if (path === '/api/config/mcp-capabilities') {
        const response = Response.json({ projectLocal: true });
        const readJson = response.json.bind(response);
        spyOn(response, 'json').mockImplementation(async () => {
          const body: unknown = await readJson();
          markCapabilityConsumed();
          return body;
        });
        return response;
      }
      if (path === '/api/config') return Response.json([]);
      if (path === `/api/config/mcp/${draft.name}` && request.method === 'POST') {
        posts.push(request);
        return Response.json({ success: true });
      }
      if (path === '/api/config/mcp') return Response.json(posts.length === 0 ? [] : [{
        name: draft.name, scope: 'local', type: 'remote', url: draft.url,
      }]);
      return Response.json(projectSettings);
    });
    useMcpConfigStore.setState({ selectedMcpName: draft.name, mcpDraft: draft });
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    // Body parsing can outlast popup opening; commit capability before choosing a scope.
    await act(async () => { await capabilityConsumed; });
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
    if (!trigger) throw new Error('Missing scope selector');

    // When the person chooses the local scope and confirms creation.
    await clickWithPointer(trigger, pointerType);
    const local = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
      .find((item) => item.textContent?.includes(dict['settings.mcp.grid.scope.local']));
    if (!local) throw new Error('Missing Local project option');
    expect(local.getAttribute('aria-disabled')).not.toBe('true');
    await clickWithPointer(local, pointerType);
    expect(trigger.textContent).toContain(dict['settings.mcp.grid.scope.local']);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const create = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === dict['settings.common.actions.create']);
    if (!create) throw new Error('Missing create action');
    await clickWithPointer(create, pointerType);

    // Then the real page, store, and runtimeFetch serialize the selected owner.
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (!post) throw new Error('Missing create request');
    expect(new URL(post.url).pathname).toBe(`/api/config/mcp/${draft.name}`);
    expect(new URL(post.url).searchParams.get('directory')).toBe('/project');
    expect(post.headers.get('x-opencode-directory')).toBe('/project');
    const body: unknown = await post.json();
    expect(body).toMatchObject({ scope: 'local', type: 'remote', url: draft.url });
  });
}
