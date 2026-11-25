import { Window } from 'happy-dom';
import type React from 'react';

import type { Session, ToolPart } from '@/lib/opencode/model';
import type { ThemeContextValue } from '@/contexts/theme-system-context';

/** A real one-pixel PNG: the bytes a retained page must draw once its file is gone. */
const PLOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const PLOT_DATA_URL = `data:image/png;base64,${PLOT_PNG}`;
export const SESSION_ID = 'ses_conversation';
export const SCOPE = { projectId: 'project-1', itemId: 'item-1' };
export const GRANT_PATH = `/api/openchamber/sessions/${SESSION_ID}/markdown-image-grants`;
export const ANSWER_PATH = '/api/openchamber/render/answer';
export const RAW_PATH = '/api/fs/raw';

type Body = { readonly format: 'html' | 'ui'; readonly content: string };
type Asset = { readonly source: string; readonly status: 'missing' | 'rejected' | 'too-heavy' | 'external' };

/**
 * One render call and the page the owner retained for it. Each test takes its
 * own hex digit, so a snapshot one test read is never another test's page.
 */
export function retainedCase(digit: string) {
  const artifactId = `artifact_${digit.repeat(64)}`;
  const callId = `call-${digit}`;
  const metadata = (incompleteAssets: readonly Asset[], interaction: string) => ({
    id: artifactId, title: 'Latency', kind: 'evidence', createdAt: 1,
    source: { sessionId: SESSION_ID, callId, producer: { role: 'conversation' }, messageId: 'msg-1' },
    interaction, incompleteAssets,
  });
  return {
    artifactId, callId,
    path: `/api/projects/${SCOPE.projectId}/bots/items/${SCOPE.itemId}/artifacts/${artifactId}`,
    /** The owner's read of the page, as its route answers it. */
    read: ({ body, missing = [], interaction = 'none', page, pageError }: {
      readonly body: Body; readonly missing?: readonly Asset[]; readonly interaction?: string; readonly page?: object;
      readonly pageError?: 'BOT_ARTIFACT_PAGE_UNAVAILABLE';
    }) => {
      const snapshot = {
        artifact: metadata(missing, interaction),
        payload: { version: 1, body, assets: [{ source: '/repo/plot.png', status: 'ready', mime: 'image/png', data: PLOT_PNG }, ...missing] },
      };
      if (pageError) return { ...snapshot, pageError };
      return page ? { ...snapshot, page } : snapshot;
    },
    /** What capture records on the call before it waits or returns. */
    captured: { openchamber: { artifact: { ...metadata([], 'none'), incompleteAssets: [], publication: 'captured' } } },
    /** The completed call as the transcript holds it, with the reference in its result. */
    call: (input: { readonly html: string } | { readonly ui: string }): ToolPart => ({
      id: `part-${digit}`, sessionID: SESSION_ID, messageID: 'msg-1', type: 'tool', tool: 'openchamber_render', callID: callId,
      state: {
        status: 'completed', input: { ...input, title: 'Latency' }, time: { start: 1, end: 2 },
        metadata: { openchamber: { ok: true } },
        output: JSON.stringify({
          schemaVersion: 1, ok: true, action: 'render.page',
          data: { title: 'Latency', artifact: { ...metadata([], 'none'), publication: 'published' } },
        }),
      },
    }),
  };
}

export const conversationSession = (bot: boolean): Session => {
  const session: Session = {
    id: SESSION_ID, projectID: SCOPE.projectId, directory: '/repo', title: 'Conversation', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  };
  if (!bot) return session;
  return { ...session, metadata: { openchamber: { automation: { source: 'bot', ...SCOPE, botId: 'bot-1', role: 'conversation' } } } };
};

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

/** What a test awaits and has not seen yet, each with the way to stop awaiting it. */
const outstanding = new Map<string, () => void>();
const awaited = <Found,>(what: string, start: (found: (value: Found) => void) => () => void): Promise<Found> => (
  new Promise<Found>((resolve) => {
    const stop = start((value) => {
      outstanding.delete(what);
      stop();
      resolve(value);
    });
    outstanding.set(what, stop);
  })
);

/**
 * Run after each test. The runner's own limit ends a test that awaits what never
 * happens and names only the test; this names what it was still awaiting.
 */
export function reportOutstanding(): void {
  const missed = [...outstanding.keys()];
  for (const stop of outstanding.values()) stop();
  outstanding.clear();
  if (missed.length > 0) throw new Error(`Never happened: ${missed.join('; ')}`);
}
const GLOBALS = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'Node', 'Text', 'Element', 'HTMLElement',
  'HTMLIFrameElement', 'HTMLImageElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement',
  'DocumentFragment', 'ShadowRoot', 'DOMParser', 'customElements', 'Event', 'CustomEvent', 'MessageEvent', 'KeyboardEvent',
  'MouseEvent', 'PointerEvent', 'FocusEvent', 'MutationObserver', 'ResizeObserver'] as const;

/**
 * A browser and the HTTP boundary for one test file. Requests the route does
 * not answer never settle, as an unreachable runtime would leave them.
 */
export function installRetainedPageStand() {
  const browser = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const set = <Value,>(name: string, value: Value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of GLOBALS) set(name, browser[name]);
  set('getComputedStyle', browser.getComputedStyle.bind(browser));
  set('requestAnimationFrame', browser.requestAnimationFrame.bind(browser));
  set('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser));
  const requests: { readonly path: string; readonly body: string }[] = [];
  const watchers = new Set<(path: string) => void>();
  let route: Route = () => undefined;
  const originalFetch = globalThis.fetch;
  set('fetch', Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    requests.push({ path: url.pathname, body: String(init?.body ?? '') });
    for (const watch of watchers) watch(url.pathname);
    return route(url, init) ?? new Promise<Response>(() => {});
  }, originalFetch));
  return {
    requests,
    paths: () => requests.map((request) => request.path),
    serve: (next: Route) => { requests.length = 0; route = next; },
    /** Subscribe before the action that should send the request. */
    request: (path: string) => awaited<string>(`a request to ${path}`, (found) => {
      const watch = (seen: string) => { if (seen === path) found(seen); };
      watchers.add(watch);
      return () => { watchers.delete(watch); };
    }),
    restore: async () => {
      await browser.happyDOM.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

/** Resolves once the document shows what `read` looks for; `reportOutstanding` names `what` when it never does. */
export function appears<Found>(what: string, read: () => Found | null | undefined): Promise<Found> {
  const shown = read();
  if (shown !== null && shown !== undefined) return Promise.resolve(shown);
  return awaited<Found>(what, (found) => {
    const observer = new MutationObserver(() => {
      const next = read();
      if (next !== null && next !== undefined) found(next);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => observer.disconnect();
  });
}

/** The providers a page is drawn under in the app, with no part of the page renderer replaced. */
export async function loadRetainedPageApp() {
  const { createRoot } = await import('react-dom/client');
  const { OpenCode } = await import('@opencode/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
  const { getDefaultTheme } = await import('@/lib/theme/themes');
  const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
  const { useGlobalBlockingRequestsStore } = await import('@/sync/global-blocking-requests');
  const { useUiBlockComponent } = await import('@/components/chat/uiBlocks/useUiBlockComponent');
  const { loadMarkdownRendererModule } = await import('@/components/chat/markdownRendererLoader');
  await Promise.all([useUiBlockComponent.load(), loadMarkdownRendererModule()]);
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: () => new Promise<Response>(() => {}) });
  const theme = getDefaultTheme(false);
  const unused = () => { throw new Error('The theme is fixed in this stand'); };
  const themeSystem: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
    isSystemPreference: false, themeMode: 'light', lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id,
    setTheme: unused, reloadCustomThemes: unused, importTheme: unused, deleteImportedTheme: unused,
    setSystemPreference: unused, setThemeMode: unused, setLightThemePreference: unused, setDarkThemePreference: unused,
  };
  const mount = (node: React.ReactNode) => {
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    const draw = (next: React.ReactNode) => root.render(
      <SyncProvider sdk={sdk} directory="/repo"><I18nProvider>
        <ThemeSystemContext.Provider value={themeSystem}>{next}</ThemeSystemContext.Provider>
      </I18nProvider></SyncProvider>,
    );
    draw(node);
    return { host, update: draw, unmount: () => { root.unmount(); host.remove(); } };
  };
  return {
    mount,
    openSession: (session: Session) => useGlobalSessionsStore.setState({ entityById: new Map([[session.id, session]]) }),
    /** The window before the session list has this conversation: nothing says yet whose session it is. */
    forgetSession: () => useGlobalSessionsStore.setState({ entityById: new Map() }),
    /** What the server's waiting index holds: the one source that opens a page's question. */
    announceWaiting: (callId: string | null) => useGlobalBlockingRequestsStore.setState({
      bySession: new Map(callId ? [[SESSION_ID, {
        directory: '/repo', permissions: [], forms: [], pages: [{ id: callId, sessionID: SESSION_ID, title: 'Latency' }],
      }]] : []),
    }),
  };
}
