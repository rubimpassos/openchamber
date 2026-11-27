import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { botSession } from '@/lib/bots/bots.fixture';
import { createProjectIdFromPath } from '@/lib/projectId';
import { installSuggestedTasksDom } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const originalFetch = globalThis.fetch;
// The hook remembers per folder whether the panel was left closed, so each test works in its own folder.
let directory = '/repo';
let folders = 0;
const projects = () => [{ id: createProjectIdFromPath(directory), path: directory }];
// The sessions come from the stores the hook reads. The server only confirms the project list, which the
// projects store adopts on startup: the selection owner admits sessions of known projects only.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  return Response.json(path === '/api/config/settings' ? { projects: projects() } : {});
}, originalFetch);
const { createRoot } = await import('react-dom/client');
const { SyncProvider } = await import('@/sync/sync-context');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useBotPanelTab } = await import('@/hooks/useBotPanelSession');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { createWebAPIs } = await import('../../../../web/src/api');
const { ContextPanel } = await import('@/components/layout/ContextPanel');
const apis = createWebAPIs();
const sdk = OpenCode.make({ baseUrl: 'http://bot-panel.test', fetch: () => new Promise<Response>(() => undefined) });
const sessionsIn = (folder: string) => [
  botSession('ses_main', { directory: folder, metadata: { openchamber: { automation: { source: 'bot', role: 'main', botId: 'bot-1' } } } }),
  botSession('ses_item', { directory: folder, metadata: { openchamber: { automation: { source: 'bot', role: 'conversation', projectId: 'project-1', botId: 'bot-1', itemId: 'item-1' } } } }),
  botSession('ses_plain', { directory: folder }),
];
const initialUI = useUIStore.getState();
const initialSessionUI = useSessionUIStore.getState();
const initialGlobal = useGlobalSessionsStore.getState();
const initialProjects = useProjectsStore.getState();
let root: Root;

const Harness = ({ folder }: { readonly folder: string }) => { useBotPanelTab(folder); return null; };
const show = (sessionId: string) => act(async () => useSessionUIStore.getState().setCurrentSession(sessionId, directory));
const panel = () => useUIStore.getState().contextPanelByDirectory[directory];
const botTab = () => panel()?.tabs.find((tab) => tab.mode === 'bot');
const botPanelOpen = () => Boolean(panel()?.isOpen && panel()?.activeTabId === botTab()?.id && botTab());

beforeEach(async () => {
  folders += 1;
  directory = `/repo-${folders}`;
  useUIStore.setState({ contextPanelByDirectory: {}, contextZoneReturnStack: {}, contextSurfaceZones: {}, contextRailHiddenSurfaces: [] });
  const sessions = sessionsIn(directory);
  useProjectsStore.setState({ projects: projects() });
  useGlobalSessionsStore.setState({ activeSessions: sessions, archivedSessions: [], entityById: new Map(sessions.map((session) => [session.id, session])), hasLoaded: true, managedChatsHydrated: true });
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(<SyncProvider sdk={sdk} directory={directory}><Harness folder={directory} /></SyncProvider>));
  await show('ses_plain');
});
afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI, true);
  useSessionUIStore.setState(initialSessionUI, true);
  useGlobalSessionsStore.setState(initialGlobal, true);
  useProjectsStore.setState(initialProjects, true);
  document.body.replaceChildren();
});
afterAll(async () => { globalThis.fetch = originalFetch; await dom.restore(); });

describe('Bot panel tab', () => {
  test('offers the Bot panel only while a bot session is on screen', async () => {
    // Given an ordinary session.
    expect(botTab()).toBeUndefined();

    // When a bot's main chat, then an item conversation, then an ordinary session come on screen.
    await show('ses_main');
    const inMainChat = Boolean(botTab());
    await show('ses_item');
    const inItemConversation = Boolean(botTab());
    await show('ses_plain');

    // Then the tab exists for both kinds of bot session and is gone with them.
    expect([inMainChat, inItemConversation, Boolean(botTab())]).toEqual([true, true, false]);
  });

  test('opens by itself on entering a bot session, and stays closed once the person closed it', async () => {
    // Given a bot session opened with nothing in the right zone.
    await show('ses_main');
    expect(botPanelOpen()).toBe(true);

    // When the person closes the panel, leaves for an ordinary session and comes back to a bot session.
    await act(async () => useUIStore.getState().closeContextZone(directory, 'right'));
    await show('ses_plain');
    await show('ses_item');

    // Then the panel is offered again but stays closed.
    expect(botTab()).toBeDefined();
    expect(botPanelOpen()).toBe(false);
  });

  test('comes back open when it was open as the bot session was left', async () => {
    // Given a bot session whose panel is on screen.
    await show('ses_main');
    const openInBotSession = botPanelOpen();

    // When the person visits an ordinary session and returns.
    await show('ses_plain');
    const closedWithSession = !panel()?.isOpen;
    await show('ses_main');

    // Then the panel left with the bot session and returns with it.
    expect([openInBotSession, closedWithSession, botPanelOpen()]).toEqual([true, true, true]);
  });

  test('leaves another panel on screen alone', async () => {
    // Given Git is open in the right zone.
    await act(async () => useUIStore.getState().openContextPanelTab(directory, { mode: 'git' }));

    // When a bot session comes on screen.
    await show('ses_main');

    // Then the Bot panel is offered and Git stays the panel shown.
    expect(botTab()).toBeDefined();
    expect(panel()?.tabs.find((tab) => tab.id === panel()?.activeTabId)?.mode).toBe('git');

    // When the person closes Git, leaves and enters a bot session again.
    await act(async () => useUIStore.getState().closeContextZone(directory, 'right'));
    await show('ses_plain');
    await show('ses_item');

    // Then the panel opens: it was never on screen here, so nobody closed it.
    expect(botPanelOpen()).toBe(true);
  });

  test('takes its tab out of a folder the person leaves', async () => {
    // Given a bot session with its panel open in one folder.
    await show('ses_main');
    const left = directory;
    expect(botPanelOpen()).toBe(true);

    // When the workspace moves to another folder.
    await act(async () => root.render(<SyncProvider sdk={sdk} directory={directory}><Harness folder="/elsewhere" /></SyncProvider>));

    // Then the folder left behind keeps no Bot tab and no open zone for a later ordinary session to show.
    const behind = useUIStore.getState().contextPanelByDirectory[left];
    expect(behind?.tabs.some((tab) => tab.mode === 'bot')).toBe(false);
    expect(behind?.isOpen).toBe(false);
  });

  test('opens by itself without taking keyboard focus, which an open the person asked for does take', async () => {
    // Given the real right zone beside a field the person is typing in.
    const nextFrame = () => act(() => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }));
    await act(async () => root.render(
      <RuntimeAPIProvider apis={apis}><ThemeSystemProvider><SyncProvider sdk={sdk} directory={directory}><I18nProvider>
        <textarea aria-label="composer" /><ContextPanel />
      </I18nProvider></SyncProvider></ThemeSystemProvider></RuntimeAPIProvider>,
    ));
    const composer = document.querySelector('textarea');
    const zone = document.querySelector('[data-context-zone="right"]');
    composer?.focus();

    // When a bot session comes on screen and its panel opens by itself.
    await show('ses_main');
    await nextFrame();
    await nextFrame();

    // Then the panel is open and focus is still in the field.
    expect(zone?.getAttribute('data-context-panel-open')).toBe('true');
    expect(document.activeElement === composer).toBe(true);

    // When the person closes the zone and opens a panel from the rail.
    await act(async () => useUIStore.getState().closeContextZone(directory, 'right'));
    await act(async () => useUIStore.getState().openContextSurface(directory, 'git'));
    await nextFrame();
    await nextFrame();

    // Then that open moves focus into the zone, as before.
    expect(zone?.contains(document.activeElement)).toBe(true);
  });
});
