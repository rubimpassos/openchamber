import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { McpDraft, McpScope } from '@/stores/useMcpConfigStore';
import { dict } from '@/lib/i18n/messages/en';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLButtonElement: browser.HTMLButtonElement, ShadowRoot: browser.ShadowRoot,
  DocumentFragment: browser.DocumentFragment, KeyboardEvent: browser.KeyboardEvent,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { McpPage } = await import('./McpPage');
const { McpScopeSelect } = await import('./McpScopeSelect');
const initialConfigState = useMcpConfigStore.getState();
const initialRuntimeState = useMcpStore.getState();
const container = document.createElement('div');
document.body.appendChild(container);
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  root = createRoot(container);
  useMcpConfigStore.setState(initialConfigState);
  useMcpStore.setState({ ...initialRuntimeState, refresh: async () => {} });
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  fetchSpy.mockImplementation(async () => Response.json({ home: '/test' }));
});
afterEach(async () => { await act(async () => root.unmount()); });
afterAll(() => { fetchSpy.mockRestore(); browser.close(); });

test('an MCP catalog echo preserves a newer draft before and after save completion', async () => {
  const writes: Array<{ value: string; finish: () => void }> = [];
  const server = { name: 'test', type: 'remote' as const, url: 'https://initial.test' };
  useMcpStore.setState({ refresh: async () => {} });
  useMcpConfigStore.setState({
    selectedMcpName: 'test', serversByDirectory: { __default__: [server] },
    getMcpByName: () => useMcpConfigStore.getState().serversByDirectory.__default__?.[0],
    updateMcp: async (_name, config) => new Promise((resolve) => {
      writes.push({ value: config.url ?? '', finish: () => resolve({ ok: true }) });
    }),
  });
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
  const field = [...container.querySelectorAll<HTMLInputElement>('input')].find((entry) => entry.value === server.url);
  if (!field) throw new Error('Missing MCP URL field');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing input setter');
  const edit = async (value: string, blur = true) => {
    await act(async () => { setValue.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
    if (blur) await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  };
  await edit('https://older.test ');
  await edit('https://newer.test', false);
  expect(writes.map((write) => write.value)).toEqual(['https://older.test ']);
  const echo = () => useMcpConfigStore.setState({ serversByDirectory: { __default__: [{ ...server, url: 'https://older.test' }] } });
  await act(async () => { echo(); });
  expect(field.value).toBe('https://newer.test');
  await act(async () => { writes[0].finish(); });
  await act(async () => { echo(); });
  expect(field.value).toBe('https://newer.test');
  await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  expect(writes.map((write) => write.value)).toEqual(['https://older.test ', 'https://newer.test']);
  await act(async () => { echo(); });
  expect(field.value).toBe('https://newer.test');
  await act(async () => {
    useMcpConfigStore.setState({ selectedMcpName: 'other', serversByDirectory: { __default__: [{ ...server, name: 'other', url: 'https://older.test ' }] } });
  });
  expect(field.value).toBe('https://older.test ');
  await act(async () => { writes[1].finish(); });
});

test('an existing local entry autosaves with its owner while capability is unknown', async () => {
  // Given
  const scopes: Array<McpScope | undefined> = [];
  const server = { name: 'private', type: 'remote' as const, scope: 'local' as const, url: 'https://initial.test' };
  useMcpConfigStore.setState({
    selectedMcpName: server.name, serversByDirectory: { __default__: [server] },
    updateMcp: async (_name, config) => { scopes.push(config.scope); return { ok: true }; },
  });
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
  const field = [...container.querySelectorAll<HTMLInputElement>('input')].find((entry) => entry.value === server.url);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!field || !setter) throw new Error('Missing MCP URL field');
  // When
  await act(async () => {
    setter.call(field, 'https://edited.test');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  // Then
  expect(scopes).toEqual(['local']);
  expect(container.querySelector('[data-slot="select-trigger"]')).toBeNull();
  expect(container.textContent).toContain(dict['settings.mcp.grid.scope.local']);
});

for (const { support, directory, disabled } of [
  { support: null, directory: '/project', disabled: true },
  { support: false, directory: '/project', disabled: true },
  { support: true, directory: null, disabled: true },
  { support: true, directory: '/project', disabled: false },
]) {
  test(`local selection respects capability ${support} and directory ${directory}`, async () => {
    // Given
    const selections: McpScope[] = [];
    await act(async () => {
      root.render(<I18nProvider><McpScopeSelect value="user" onChange={(scope) => selections.push(scope)} projectLocal={support} directory={directory} /></I18nProvider>);
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
    if (!trigger) throw new Error('Missing scope trigger');
    await act(async () => { trigger.click(); });
    const local = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
      .find((item) => item.textContent?.includes(dict['settings.mcp.grid.scope.local']));
    if (!local) throw new Error('Missing local scope option');
    // When
    await act(async () => { local.focus(); });
    await act(async () => { local.click(); });
    // Then
    expect(local.getAttribute('aria-disabled') === 'true').toBe(disabled);
    expect(selections).toEqual(disabled ? [] : ['local']);
  });
}

const privateDraft: McpDraft = {
  name: 'private', scope: 'local', type: 'remote', command: [], url: 'https://mcp.test',
  environment: [], headers: [], oauthEnabled: false, oauthClientId: '', oauthClientSecret: '',
  oauthScope: '', oauthRedirectUri: '', oauthCallbackPort: '', oauthAuthServerMetadataUrl: '',
  protocol: 'legacy', timeoutStartup: '', timeoutCatalog: '', timeoutExecution: '', codemode: 'default', disabled: false,
};

for (const { payload, status, disabled } of [
  { payload: { projectLocal: true }, status: 200, disabled: false },
  { payload: { projectLocal: false }, status: 200, disabled: true },
  { payload: { projectLocal: 'true' }, status: 200, disabled: true },
  { payload: {}, status: 200, disabled: true },
  { payload: { projectLocal: true }, status: 503, disabled: true },
]) {
  test(`creation parses capability ${JSON.stringify(payload)} at HTTP status ${status}`, async () => {
    // Given
    useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' });
    useMcpConfigStore.setState({ selectedMcpName: privateDraft.name, mcpDraft: privateDraft });
    fetchSpy.mockImplementation(async () => Response.json(payload, { status }));
    // When
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    // Then
    const create = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === dict['settings.common.actions.create']);
    expect(create?.disabled).toBe(disabled);
  });
}

test('confirmed local creation sends the chosen scope and Settings directory', async () => {
  // Given
  const creations: Array<{ scope: McpScope; directory: string | null | undefined }> = [];
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' });
  useMcpConfigStore.setState({
    selectedMcpName: privateDraft.name, mcpDraft: privateDraft,
    createMcp: async (config, directory) => { creations.push({ scope: config.scope, directory }); return { ok: true }; },
  });
  fetchSpy.mockImplementation(async () => Response.json({ projectLocal: true }));
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
  const create = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === dict['settings.common.actions.create']);
  if (!create) throw new Error('Missing create action');
  // When
  await act(async () => { create.click(); });
  // Then
  expect(creations).toEqual([{ scope: 'local', directory: '/project' }]);
});

test('deleting a private project entry describes host storage without a repo config path', async () => {
  // Given
  const server = { name: 'private', type: 'local' as const, scope: 'local' as const, command: ['mcp'], legacy: true, path: '/project/opencode.json' };
  useMcpConfigStore.setState({ selectedMcpName: server.name, serversByDirectory: { __default__: [server] } });
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
  const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === dict['settings.common.actions.delete']);
  if (!remove) throw new Error('Missing delete action');
  // When
  await act(async () => { remove.click(); });
  // Then
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(dict['settings.mcp.page.deleteDialog.localDescription']);
  expect(document.body.textContent).not.toContain('opencode.json');
});

test('grid deletion retains the card owner when a refresh reveals a shared fallback', async () => {
  // Given a confirmation opened from the local card.
  const server = { name: 'expected-owner', type: 'local' as const, scope: 'local' as const, command: ['mcp'] };
  const deletedScopes: Array<McpScope | undefined> = [];
  useMcpConfigStore.setState({
    selectedMcpName: null, serversByDirectory: { __default__: [server] },
    loadMcpConfigs: async () => true,
    deleteMcp: async (_name, _directory, scope) => { deletedScopes.push(scope); return { ok: true }; },
  });
  await act(async () => { root.render(<ThemeSystemProvider><I18nProvider><McpPage /></I18nProvider></ThemeSystemProvider>); });
  const actions = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === dict['settings.mcp.grid.actionsAria'].replace('{name}', server.name));
  if (!actions) throw new Error('Missing card actions');
  await act(async () => { actions.click(); });
  const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === dict['settings.common.actions.delete']);
  if (!remove) throw new Error('Missing card delete action');
  await act(async () => { remove.click(); });
  await act(async () => {
    useMcpConfigStore.setState({ serversByDirectory: { __default__: [{ ...server, scope: 'project' }] } });
  });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === dict['settings.common.actions.delete']);
  if (!confirm) throw new Error('Missing card delete confirmation');
  // When
  await act(async () => { confirm.click(); });
  // Then the server receives the local owner precondition and can reject the stale delete.
  expect(deletedScopes).toEqual(['local']);
});

for (const scope of ['user', 'project', 'local'] as const) {
  test(`deleting from the editor carries the displayed ${scope} owner`, async () => {
    // Given
    const server = { name: 'expected-owner', type: 'local' as const, scope, command: ['mcp'] };
    const deletedScopes: Array<McpScope | undefined> = [];
    useMcpConfigStore.setState({
      selectedMcpName: server.name, serversByDirectory: { __default__: [server] },
      deleteMcp: async (_name, _directory, expectedScope) => { deletedScopes.push(expectedScope); return { ok: true }; },
    });
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === dict['settings.common.actions.delete']);
    if (!remove) throw new Error('Missing delete action');
    await act(async () => { remove.click(); });
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === dict['settings.common.actions.delete']);
    if (!confirm) throw new Error('Missing delete confirmation');
    // When
    await act(async () => { confirm.click(); });
    // Then
    expect(deletedScopes).toEqual([scope]);
  });

  test(`plaintext storage warnings describe the ${scope} owner in environment and headers`, async () => {
    // Given a server whose environment and headers both need a storage warning.
    const server = {
      name: 'storage-warning', type: 'remote' as const, scope, url: 'https://mcp.test',
      environment: { TEST_VALUE: 'fixture' }, headers: { 'X-Test-Value': 'fixture' },
    };
    useMcpConfigStore.setState({ selectedMcpName: server.name, serversByDirectory: { __default__: [server] } });
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    const advanced = container.querySelector<HTMLButtonElement>('[data-settings-item="mcp.advanced"] button');
    if (!advanced) throw new Error('Missing advanced options');
    // When the header editor is shown alongside the environment editor.
    await act(async () => { advanced.click(); });
    // Then both editors identify the scope's actual storage location.
    const expected = dict[scope === 'local'
      ? 'settings.mcp.page.env.localPlainTextWarning'
      : 'settings.mcp.page.env.plainTextWarning'];
    expect([...container.querySelectorAll('p')].filter((paragraph) => paragraph.textContent === expected)).toHaveLength(2);
    if (scope === 'local') expect(container.textContent).not.toContain('opencode.json');
  });
}
