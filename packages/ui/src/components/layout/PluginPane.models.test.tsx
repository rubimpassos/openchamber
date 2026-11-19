import { afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import type { Model } from '@/lib/opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

const model: Model = {
  id: 'model-fast', modelID: 'model', providerID: 'fixture', name: 'Model Fast',
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high' }],
  time: { released: 0 }, cost: [], status: 'active', enabled: true, limit: { context: 0, output: 0 },
  headers: { Authorization: 'model-secret' }, settings: { apiKey: 'model-secret' },
};
const provider = {
  id: 'fixture', name: 'Fixture', activation: 'enabled', package: 'fixture',
  settings: { apiKey: 'provider-secret' }, headers: { Authorization: 'provider-secret' },
  models: [model, { ...model, id: 'hidden' }, { ...model, id: 'plain', name: 'Plain', variants: [] }],
} satisfies ReturnType<typeof useConfigStore.getState>['providers'][number];
const guest: InstalledGuest = {
  id: 'catalog', name: 'Catalog', icon: 'window', pageEntry: 'page/index.html', source: 'path',
  capabilities: { requested: ['model'], granted: ['model'] },
};
const request = { channel: 'openchamber.sdk', v: 1, type: 'listModels', id: 'models-1' } as const;

let send: () => Promise<void>;
let received: HostMessage[];
let cleanup: () => Promise<void>;

const mountPage = async (installed: InstalledGuest = guest) => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event,
    MessageEvent: dom.MessageEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/frame-grant')) return Response.json({ grant: 'fixture', expiresAt: Date.now() + 60_000 });
    if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (target.includes('/session/active')) return Response.json({});
    if (target.includes('/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 0, sessions: [] });
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json(url.includes('/session/active') ? {} : { data: [] });
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const previousConfig = useConfigStore.getState();
  const previousHidden = useUIStore.getState().hiddenModels;
  const previousGuests = useGuestsStore.getState();
  useConfigStore.setState({ providers: [provider], providersLoaded: true, activeDirectoryKey: '/visible', directoryScoped: {} });
  useUIStore.setState({ hiddenModels: [{ providerID: 'fixture', modelID: 'hidden' }] });
  useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  useGuestsStore.getState().replaceCatalog([installed], getRuntimeKey());
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let restoreFrame = () => {};
  cleanup = async () => {
    await act(async () => root.unmount());
    restoreFrame();
    fetch.mockRestore();
    useConfigStore.setState(previousConfig);
    useUIStore.setState({ hiddenModels: previousHidden });
    useGuestsStore.setState(previousGuests);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  await act(async () => root.render(
    <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory="/visible"><PluginPane mode="plugin:catalog" surface="page" pinnedDirectory="/visible" /></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>,
  ));
  const frame = container.querySelector<HTMLIFrameElement>('iframe');
  if (!frame) throw new Error('Page iframe did not mount');
  const guestWindow = new Window();
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
  const frameWindow = frame.contentWindow;
  if (!frameWindow) throw new Error('Guest window is missing');
  received = [];
  const post = spyOn(frameWindow, 'postMessage').mockImplementation((data) => { received.push(hostMessageSchema.parse(data)); });
  restoreFrame = () => { post.mockRestore(); void guestWindow.happyDOM.close(); };
  send = async () => {
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: request })); });
  };
};

afterEach(async () => { await cleanup(); });
const reply = () => received.find((message) => message.type === 'result' && message.id === request.id);

test('returns only visible catalog IDs and variant IDs when a page has model approval', async () => {
  // Given: a page-only guest and a catalog with credentials, a derived model and a hidden model.
  await mountPage();
  // When
  await send();
  // Then
  expect(reply()).toEqual({ channel: 'openchamber.sdk', v: 1, type: 'result', id: request.id, ok: true, payload: [
    { id: 'fixture/model-fast', name: 'Model Fast', variants: ['low', 'high'] },
    { id: 'fixture/plain', name: 'Plain', variants: [] },
  ] });
});

test('refuses catalog access when the active page lacks the model capability', async () => {
  // Given
  await mountPage({ ...guest, capabilities: { requested: [], granted: [] } });
  // When
  await send();
  // Then
  expect(reply()).toMatchObject({ ok: false, code: 'NOT_GRANTED' });
});

test('returns an unavailable result when the page catalog has not loaded', async () => {
  // Given
  await mountPage();
  useConfigStore.setState({ providers: [], providersLoaded: false });
  // When
  await send();
  // Then
  expect(reply()).toMatchObject({ ok: false, code: 'HOST_UNAVAILABLE' });
});

test('returns an empty list when the page catalog loaded successfully with no models', async () => {
  // Given
  await mountPage();
  useConfigStore.setState({ providers: [], providersLoaded: true });
  // When
  await send();
  // Then
  expect(reply()).toMatchObject({ ok: true, payload: [] });
});

test('reads the page directory when the active session uses another catalog', async () => {
  // Given
  await mountPage();
  useConfigStore.setState({ activeDirectoryKey: '/other', providers: [], directoryScoped: {
    '/visible': { providers: [provider], providersLoaded: true, agents: [], currentProviderId: '',
      currentModelId: '', currentAgentName: undefined, selectedProviderId: '', agentModelSelections: {}, defaultProviders: {} },
  } });
  // When
  await send();
  // Then
  expect(reply()).toMatchObject({ ok: true, payload: [
    { id: 'fixture/model-fast', name: 'Model Fast', variants: ['low', 'high'] },
    { id: 'fixture/plain', name: 'Plain', variants: [] },
  ] });
});
