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
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
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

const protectedDraft: McpDraft = {
  name: 'protected-scope-probe', scope: 'user', type: 'remote', command: [], url: 'https://mcp.test',
  environment: [], headers: [], oauthEnabled: false, oauthClientId: '', oauthClientSecret: '',
  oauthScope: '', oauthRedirectUri: '', oauthCallbackPort: '', oauthAuthServerMetadataUrl: '',
  protocol: 'legacy', timeoutStartup: '', timeoutCatalog: '', timeoutExecution: '', codemode: 'default', disabled: false,
};

for (const service of ['unsupported', 'not_installed', 'unreachable', 'available'] as const) {
  test(`protected scope ${service} controls availability and routes creation without changing OpenCode scopes`, async () => {
    // Given a new server and the connected host's protected-service status.
    useMcpConfigStore.setState({ selectedMcpName: protectedDraft.name, selectedProtectedId: null, mcpDraft: protectedDraft });
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
      const path = new URL(request.url).pathname;
      if (path === '/api/config/mcp-capabilities') return Response.json({ projectLocal: true });
      if (path === '/api/config') return Response.json([]);
      if (path === '/api/protected-mcp/status') {
        if (service === 'unsupported') return Response.json({ code: 'unsupported_host' }, { status: 501 });
        return Response.json({
          host: { supported: true },
          service: service === 'available' ? { state: 'available', status: {
            administration: 'shared', enforcement: { status: 'protected', findings: [] }, connections: [],
          } } : { state: service },
          selections: { global: {}, project: {}, effective: {} }, selectionsError: null,
        });
      }
      return Response.json(projectSettings);
    });
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
    if (!trigger) throw new Error('Missing scope selector');
    // When the person opens the scope picker.
    await clickWithPointer(trigger, 'mouse');
    const protectedOption = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
      .find((entry) => entry.textContent === dict['settings.mcp.page.scope.protected']);
    // Then unsupported or missing services hide it; a reachable service opens the protected form.
    if (service === 'unsupported' || service === 'not_installed') {
      expect(protectedOption).toBeUndefined();
      return;
    }
    if (!protectedOption) throw new Error('Missing Protected option');
    if (service === 'unreachable') {
      expect(protectedOption.getAttribute('aria-disabled')).toBe('true');
      expect(document.body.textContent).toContain(dict['settings.mcp.protected.service.unreachable']);
      return;
    }
    await clickWithPointer(protectedOption, 'mouse');
    expect(container.textContent).toContain(dict['settings.mcp.protectedPage.useIn']);
    expect(container.textContent).toContain(dict['settings.mcp.protectedPage.tools']);
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Server name"]');
    expect(name?.value).toBe(protectedDraft.name);
    expect(container.querySelector('input[aria-label="URL"]')).not.toBeNull();
    expect(container.textContent).toContain(dict['settings.mcp.page.scope.sharedAdministration']);
    // Choosing another scope retains the name and transport in the ordinary form.
    const protectedTrigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
    if (!protectedTrigger) throw new Error('Missing protected scope selector');
    await clickWithPointer(protectedTrigger, 'mouse');
    const global = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
      .find((entry) => entry.textContent?.includes(dict['settings.mcp.grid.scope.user']));
    if (!global) throw new Error('Missing Global option');
    await clickWithPointer(global, 'mouse');
    expect(container.textContent).not.toContain(dict['settings.mcp.protectedPage.useIn']);
    expect([...container.querySelectorAll<HTMLInputElement>('input')].some((entry) => entry.value === protectedDraft.name)).toBe(true);
    expect(container.textContent).toContain(dict['settings.mcp.page.connection.kindLink']);
  });
}

for (const ending of ['cancel', 'create'] as const) {
  test(`a protected ${ending} resets scope before the next ordinary draft mounts`, async () => {
    // Given a protected draft opened through the real scope picker.
    let capabilityReads = 0;
    const definition = { name: protectedDraft.name, enabled: true, transport: 'http', http: { url: 'https://mcp.test', headers: {} }, policy: {} };
    const view = { id: 'pmcp_created_scope', name: definition.name, revision: 1, enabled: true, transport: 'http', secrets: {}, credential: 'none', editable: definition };
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
      const path = new URL(request.url).pathname;
      if (path === '/api/config/mcp-capabilities') { capabilityReads += 1; return Response.json({ projectLocal: true }); }
      if (path === '/api/config' || path === '/api/config/mcp') return Response.json([]);
      if (path === '/api/protected-mcp/status') return Response.json({
        host: { supported: true }, service: { state: 'available', status: {
          administration: 'separate', enforcement: { status: 'protected', findings: [] }, connections: [],
        } }, selections: { global: {}, project: {}, effective: {} }, selectionsError: null,
      });
      if (path.startsWith('/api/protected-mcp/connections')) return Response.json({ connection: view });
      return Response.json(projectSettings);
    });
    useMcpConfigStore.setState({ selectedMcpName: protectedDraft.name, selectedProtectedId: null, mcpDraft: protectedDraft });
    await act(async () => { root.render(<ThemeSystemProvider><I18nProvider><McpPage /></I18nProvider></ThemeSystemProvider>); });
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
    if (!trigger) throw new Error('Missing scope picker');
    await clickWithPointer(trigger, 'mouse');
    const option = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
      .find((entry) => entry.textContent === dict['settings.mcp.page.scope.protected']);
    if (!option) throw new Error('Missing Protected option');
    await clickWithPointer(option, 'mouse');
    const action = (label: string) => {
      const target = [...container.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label || entry.getAttribute('aria-label') === label);
      if (!target) throw new Error(`Missing action ${label}`);
      return target;
    };
    if (ending === 'create') {
      const url = container.querySelector<HTMLInputElement>('input[aria-label="URL"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!url || !setter) throw new Error('Missing protected URL');
      await act(async () => { setter.call(url, 'https://mcp.test'); url.dispatchEvent(new Event('input', { bubbles: true })); });
    }
    // When this protected draft ends and another server is added.
    await act(async () => { action(dict[ending === 'create' ? 'settings.common.actions.create' : 'settings.common.actions.cancel']).click(); });
    if (ending === 'create') await act(async () => { action(dict['settings.mcp.page.back']).click(); });
    const readsBeforeNextDraft = capabilityReads;
    const add = container.querySelector<HTMLButtonElement>('[data-settings-item="mcp.create"]');
    if (!add) throw new Error('Missing Add server card');
    await act(async () => { add.click(); });
    // Then an ordinary draft never mounts the protected editor, even for one commit.
    expect(container.textContent).not.toContain(dict['settings.mcp.protectedPage.useIn']);
    expect(container.querySelector('[data-slot="select-trigger"]')?.textContent).toContain(dict['settings.mcp.grid.scope.user']);
    expect(capabilityReads).toBe(readsBeforeNextDraft);
  });
}
