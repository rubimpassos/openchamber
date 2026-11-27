import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { BotChats, BotWorkItem } from '@/lib/botsApi';
import { configuredBot } from '@/lib/bots/bots.fixture';
import { deferred, installSuggestedTasksDom } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const originalFetch = globalThis.fetch;
const work = (itemId: string, patch: Partial<BotWorkItem> = {}): BotWorkItem => ({
  projectId: 'project-1', itemId, title: itemId, state: 'queued', source: { kind: 'manual', id: 'source-1' }, wait: null, question: null,
  conversation: { sessionId: `ses_${itemId}`, directory: '/host/project', createdAt: 1 }, sessions: {}, worktree: null, pr: null,
  tokens: 0, updatedAt: 1, finishedAt: null, takenOver: null, ...patch,
});
const projects = ['/host/project', '/host/main'].map((path) => ({ id: path, path }));
let definitions = [configuredBot()];
let chats: BotChats = { main: null, projects: [], items: [], available: { mainChat: true, takeOver: true } };
let listStatus = 200;
let listBody: Record<string, string> | null = null;
let chatsStatus = 200;
let listAnswers = 0;
let listGate: Promise<void> = Promise.resolve();
let mainAsks = 0;
let drawerCloses = 0;
/** Counts a list answer once the client has read its body, so a test can wait for a read to settle. */
const listAnswer = (body: Parameters<typeof Response.json>[0], status: number) => {
  const response = Response.json(body, { status });
  const read = response.json.bind(response);
  return Object.assign(response, { json: async () => { try { return await read(); } finally { listAnswers += 1; } } });
};
// Only the HTTP boundary is replaced; the hook, the parser, the section and the selection store are real.
// Install before store imports so their startup reads use the same test transport.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  if (path === '/api/bots') {
    await listGate;
    return listStatus === 200 ? listAnswer({ revision: 1, definitions, presets: [] }, 200) : listAnswer(listBody, listStatus);
  }
  if (path === '/api/bots/bot-1/chats') return chatsStatus === 200 ? Response.json(chats) : Response.json({}, { status: chatsStatus });
  if (path === '/api/bots/bot-1/main' && init?.method === 'POST') {
    mainAsks += 1;
    chats = { ...chats, main: { sessionId: 'ses_main', directory: '/host/main', createdAt: 1 } };
    return Response.json({ session: chats.main });
  }
  if (path === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' });
  // The stores adopt the projects a settings answer names; an empty one would drop the test's projects.
  if (path === '/api/config/settings') return Response.json({ projects });
  return Response.json({});
}, originalFetch);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { BotsSidebarSection } = await import('./BotsSidebarSection');
const { MobileBotsSection } = await import('@/apps/mobileSidebar/MobileBotsSection');
const { MOBILE_TREE_GEOMETRY } = await import('@/apps/mobileSidebar/mobileSidebarGeometry');
const { useBotsSidebar } = await import('@/hooks/useBotsSidebar');
const originalProjects = useProjectsStore.getState();
const originalSessionUI = useSessionUIStore.getState();
let root: Root;

/** Stands in for the sidebar list: it draws the section's row only while the model has something to show. */
function Sidebar({ phone = false }: { readonly phone?: boolean }) {
  const model = useBotsSidebar(true);
  const [collapsed, setCollapsed] = React.useState(false);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  if (!model.present) return null;
  const shared = {
    model, collapsed, expandedKeys: expanded,
    onToggle: () => setCollapsed((value) => !value),
    onToggleExpanded: (key: string) => setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    }),
  };
  return phone
    ? <MobileBotsSection {...shared} geometry={MOBILE_TREE_GEOMETRY} onNavigate={() => { drawerCloses += 1; }} />
    : <BotsSidebarSection {...shared} alwaysShowActions={false} />;
}

beforeEach(() => {
  definitions = [configuredBot()];
  chats = { main: null, projects: [], items: [], available: { mainChat: true, takeOver: true } };
  listStatus = 200; listBody = null; chatsStatus = 200; listAnswers = 0; listGate = Promise.resolve(); mainAsks = 0; drawerCloses = 0;
  // The selection owner admits sessions in known projects and worktrees.
  useProjectsStore.setState({ projects });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, availableWorktreesByProject: new Map([
    ['/host/project', [{ path: '/host/taken-worktree', projectDirectory: '/host/project', branch: 'bot-item', label: 'Bot item' }]],
  ]) });
  useUIStore.getState().closeMainSurfaces();
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  useProjectsStore.setState(originalProjects, true);
  useSessionUIStore.setState(originalSessionUI, true);
  useUIStore.getState().closeMainSurfaces();
  document.body.replaceChildren();
});
afterAll(async () => { globalThis.fetch = originalFetch; await dom.restore(); });

const text = () => document.body.textContent ?? '';
const button = (label: string) => {
  const element = [...document.querySelectorAll('button')].find((entry) => entry.textContent === label || entry.getAttribute('aria-label') === label);
  if (!(element instanceof HTMLButtonElement)) throw new TypeError(`Missing button: ${label}`);
  return element;
};
const botRow = () => {
  const element = document.querySelector('[data-bot-row="bot-1"]');
  if (!(element instanceof HTMLButtonElement)) throw new TypeError('Missing bot row');
  return element;
};
const chatIds = () => [...document.querySelectorAll('[data-bot-chat]')].map((row) => row.getAttribute('data-bot-chat'));
const chat = (sessionId: string) => {
  const element = document.querySelector(`[data-bot-chat="${sessionId}"]`);
  if (!(element instanceof HTMLButtonElement)) throw new TypeError(`Missing chat row: ${sessionId}`);
  return element;
};
// The HTTP stub answers through promises only, so flushing microtasks settles every read.
const waitFor = async (read: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read()) return;
    await act(async () => { await Promise.resolve(); });
  }
  throw new Error('Expected UI state did not appear');
};
/** Waits until the client has read that many answers of the bot list and applied the last one. */
const settled = async (answers: number) => {
  await waitFor(() => listAnswers >= answers);
  for (let tick = 0; tick < 10; tick += 1) await act(async () => { await Promise.resolve(); });
};
const renderSidebar = async (phone = false) => {
  await act(async () => root.render(<I18nProvider><Sidebar phone={phone} /></I18nProvider>));
};

describe('Bots sidebar section', () => {
  test('lists each bot with what its work needs', async () => {
    // Given a bot with one item waiting on the user, two under way, one queued, one finished and one the user took over.
    chats.items = [
      work('ask', { state: 'needs-you' }), work('fix', { state: 'fixing' }), work('judge', { state: 'judging' }),
      work('later', { state: 'queued' }), work('old', { state: 'done', finishedAt: 2 }),
      work('mine', { state: 'needs-you', takenOver: { sessionId: 'ses_mine', at: 2 } }),
    ];

    // When the sidebar shows.
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));

    // Then the bot's row counts only the work the bot still holds, and stays folded.
    expect(botRow().textContent).toContain('1 needs you · 2 working · 1 queued');
    expect(botRow().getAttribute('aria-expanded')).toBe('false');
    expect(botRow().querySelector('[aria-label="Needs you"]')).not.toBeNull();
    expect(text()).not.toContain('Main chat');
  });

  test('opens a bot to its main chat and the chats of work under way, newest first', async () => {
    // Given live items of different ages, one without a conversation, and a finished one.
    chats.items = [
      work('older', { title: 'Older repair', state: 'fixing', updatedAt: 10 }),
      work('newer', { title: 'Newer question', state: 'waiting-answer', updatedAt: 20 }),
      work('unstarted', { state: 'queued', conversation: null, updatedAt: 30 }),
      work('finished', { state: 'done', finishedAt: 40, updatedAt: 40 }),
    ];
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));

    // When the bot's row is opened.
    await act(async () => botRow().click());

    // Then the main chat leads, live conversations follow newest first, and each shows its state.
    expect(text()).toContain('Main chat');
    expect(chatIds()).toEqual(['ses_newer', 'ses_older']);
    expect(chat('ses_newer').textContent).toBe('Newer questionWaiting for an answer');
    expect(chat('ses_newer').querySelector('[aria-label="Needs you"]')).not.toBeNull();
    expect(chat('ses_older').textContent).toBe('Older repairCorrecting');
    expect(chat('ses_older').querySelector('[aria-label="Needs you"]')).toBeNull();

    // When an item chat is clicked while the Bots page is open.
    await act(async () => useUIStore.getState().setBotsPageOpen(true));
    await act(async () => chat('ses_older').click());

    // Then that conversation opens at its own address as a session, and the Bots page gives way.
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_older');
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/host/project');
    expect(useUIStore.getState().isBotsPageOpen).toBe(false);
    expect(chat('ses_older').getAttribute('aria-current')).toBe('page');
    await settled(2);
  });

  test('asks the server for the main chat before opening it', async () => {
    // Given a bot whose main chat does not exist yet.
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));
    await act(async () => botRow().click());

    // When Main chat is clicked.
    await act(async () => button('Main chat').click());
    await waitFor(() => document.querySelector('[data-bot-chat="ses_main"]') !== null);

    // Then the ensured session opens at the address the server returned, and its row is the open one.
    expect(mainAsks).toBe(1);
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_main');
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/host/main');
    expect(chat('ses_main').getAttribute('aria-current')).toBe('page');
  });

  test('keeps ended work behind Show ended and opens taken-over work as the session the user took', async () => {
    // Given one live item, one finished item and one the user took over.
    chats.items = [
      work('live', { title: 'Live repair', state: 'proving', updatedAt: 30 }),
      work('done', { title: 'Finished repair', state: 'done', finishedAt: 20, updatedAt: 20 }),
      work('taken', { title: 'Taken repair', state: 'stopped', updatedAt: 10, worktree: '/host/taken-worktree', takenOver: { sessionId: 'ses_mine', at: 10 } }),
    ];
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));
    await act(async () => botRow().click());
    expect(chatIds()).toEqual(['ses_live']);

    // When ended work is shown.
    await act(async () => button('Show ended').click());

    // Then it follows live work, and the taken-over item says so in place of a state.
    expect(chatIds()).toEqual(['ses_live', 'ses_done', 'ses_mine']);
    expect(chat('ses_mine').textContent).toBe('Taken repairTaken over');

    // When the taken-over item is clicked.
    await act(async () => chat('ses_mine').click());

    // Then the user's own session opens in the item's worktree.
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_mine');
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/host/taken-worktree');

    // When ended work is hidden again.
    await act(async () => button('Hide ended').click());
    expect(chatIds()).toEqual(['ses_live']);
  });

  test('lists five item chats before Show more', async () => {
    // Given seven live items.
    chats.items = Array.from({ length: 7 }, (_, index) => work(`item-${index}`, { state: 'fixing', updatedAt: 100 - index }));
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));
    await act(async () => botRow().click());
    expect(chatIds()).toHaveLength(5);

    // When more are asked for, then less.
    await act(async () => button('Show more').click());
    expect(chatIds()).toHaveLength(7);
    await act(async () => button('Show less').click());

    // Then the list returns to its first five.
    expect(chatIds()).toEqual(['ses_item-0', 'ses_item-1', 'ses_item-2', 'ses_item-3', 'ses_item-4']);
  });

  test('reports a failed read with a retry and never as an empty list', async () => {
    // Given a server that fails the bot list.
    listStatus = 500;
    await renderSidebar();
    await waitFor(() => text().includes('Could not load bots.'));
    expect(text()).not.toContain('Repository bot');

    // When the server recovers and the user retries.
    listStatus = 200;
    await act(async () => button('Try again').click());
    await waitFor(() => text().includes('Repository bot'));

    // Then the bots show and the error is gone.
    expect(text()).not.toContain('Could not load bots.');
  });

  test('keeps a bot listed when only its chats fail to load', async () => {
    // Given a bot list that loads and a chats read that fails.
    chatsStatus = 503;
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));

    // When the bot is opened.
    await act(async () => botRow().click());

    // Then its row says the chats are missing and offers a retry in place of a main chat.
    expect(text()).toContain('Could not load this bot\'s chats.');
    expect(text()).not.toContain('Main chat');
    chatsStatus = 200;
    await act(async () => button('Try again').click());
    await waitFor(() => text().includes('Main chat'));
  });

  for (const [name, status, body] of [['a server without bots', 501, { code: 'bots_unsupported' }], ['a server that predates bots', 404, {}]] as const) {
    test(`draws nothing on ${name}`, async () => {
      // Given a server that answers the bot list as unsupported.
      listStatus = status; listBody = body;

      // When the sidebar shows and the read settles.
      await renderSidebar();
      await settled(1);

      // Then the section is absent, with no error row.
      expect(text()).toBe('');
    });
  }

  test('reads the bots again when the Bots page closes', async () => {
    // Given the section lists one bot while the Bots page is open.
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));
    await act(async () => useUIStore.getState().setBotsPageOpen(true));

    // When a bot is added on the page and the page closes.
    definitions = [configuredBot(), { ...configuredBot(), id: 'bot-2', name: 'Release bot' }];
    await act(async () => useUIStore.getState().setBotsPageOpen(false));

    // Then the new bot appears without a reload.
    await waitFor(() => text().includes('Release bot'));
  });

  test('draws the same section in the phone\'s drawer and closes the drawer on opening a chat', async () => {
    // Given a bot with one item waiting on the user, in the phone's list.
    chats.items = [work('ask', { title: 'Question', state: 'needs-you' })];
    await renderSidebar(true);
    await waitFor(() => text().includes('Repository bot'));
    expect(botRow().textContent).toContain('1 needs you');

    // When the bot is opened and its item chat tapped.
    await act(async () => botRow().click());
    expect(text()).toContain('Main chat');
    await act(async () => chat('ses_ask').click());

    // Then the conversation opens and the drawer closes once.
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_ask');
    expect(drawerCloses).toBe(1);
  });

  test('opens a new bot in the editor from the section\'s add button', async () => {
    // Given the section with a bot and an active project.
    useProjectsStore.setState({ activeProjectId: 'project-a' });
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));

    // When the header's add button is pressed.
    await act(async () => button('New bot').click());

    // Then the Bots page opens straight into a new bot's editor.
    expect(useUIStore.getState().isBotsPageOpen).toBe(true);
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-a', newBot: true });
  });

  // Last in the file: the runtime it switches to stays for the rest of the process.
  test('hides the previous runtime\'s bots the moment the runtime changes', async () => {
    // Given one runtime's bot is listed.
    await renderSidebar();
    await waitFor(() => text().includes('Repository bot'));

    // When the app switches to a runtime whose bot list has not answered yet.
    const held = deferred<void>();
    listGate = held.promise;
    definitions = [{ ...configuredBot(), name: 'Other runtime bot' }];
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://other.test', runtimeKey: 'other-runtime' }));

    // Then nothing of the previous runtime stays on screen.
    expect(text()).toBe('');

    // When the new runtime answers.
    await act(async () => held.resolve());
    await waitFor(() => text().includes('Other runtime bot'));

    // Then only its bots are listed.
    expect(text()).not.toContain('Repository bot');
  });
});
