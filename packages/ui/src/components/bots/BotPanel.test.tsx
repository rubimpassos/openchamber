import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { BotWorkItem } from '@/lib/botsApi';
import { botItem, configuredBot } from '@/lib/bots/bots.fixture';
import { createProjectIdFromPath } from '@/lib/projectId';
import { deferred, installSuggestedTasksDom } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const originalFetch = globalThis.fetch;
const projectId = createProjectIdFromPath('/host/project');
const itemsRoute = `/api/projects/${encodeURIComponent(projectId)}/bots/items`;
const projects = [
  { id: createProjectIdFromPath('/before'), path: '/before' },
  { id: projectId, path: '/host/project', label: 'Parser service', labelSource: 'manual' as const },
];
const workItem = (patch: Partial<BotWorkItem> = {}): BotWorkItem => ({
  projectId, itemId: 'item-1', title: 'Repair parser', state: 'fixing', source: { kind: 'manual', id: 'source-1' },
  wait: null, question: null, conversation: null, sessions: {}, worktree: null, pr: null, tokens: 0, updatedAt: 1, finishedAt: null,
  takenOver: null, ...patch,
});
const artifact = (index: number, title: string, requirement?: string) => ({
  id: `artifact_${String(index).repeat(64)}`, title, kind: 'evidence', requirement, createdAt: index,
  source: { sessionId: 'ses_conversation', callId: `call-${index}`, producer: { role: 'conversation' } },
  interaction: 'none', incompleteAssets: [],
});
let bot = configuredBot();
let items: BotWorkItem[] = [];
let chatsAnswer: (() => Response) | null = null;
let takeOverAnswer: () => Response | Promise<Response> = () => Response.json({});
let posts: string[] = [];
let artifactReads: string[] = [];
let chatsReadWaiters: (() => void)[] = [];
let artifactReadWaiters: (() => void)[] = [];
/** Resolves when the bot's work is next asked for. Subscribe before the action that asks. */
const nextChatsRead = () => new Promise<void>((resolve) => { chatsReadWaiters.push(resolve); });
/** Resolves when an item's page list is next asked for. Subscribe before the action that asks. */
const nextArtifactsRead = () => new Promise<void>((resolve) => { artifactReadWaiters.push(resolve); });
// Only the HTTP boundary is replaced; the panel, its parsers and the session store are real.
// Install before module imports so their startup reads use the same test transport.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  if (init?.method === 'POST' && path.includes('/bots/')) {
    posts.push(path);
    return path.endsWith('/take-over') ? takeOverAnswer() : Response.json({});
  }
  if (path === '/api/bots/bot-1/chats') {
    for (const settle of chatsReadWaiters.splice(0)) settle();
    return chatsAnswer ? chatsAnswer() : Response.json({ main: null, projects: [{ projectId, access: 'pr' }], items });
  }
  if (path === '/api/bots') return Response.json({ revision: 1, definitions: [bot], presets: [] });
  if (path.endsWith('/artifacts')) {
    artifactReads.push(path);
    for (const settle of artifactReadWaiters.splice(0)) settle();
    return Response.json({ nextOffset: null, artifacts: [artifact(1, 'Latency before and after', 'benchmark'), artifact(2, 'Notes on the cache')] });
  }
  if (path === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' });
  // The projects store adopts the server's list on startup; an empty document would empty it.
  if (path === '/api/config/settings') return Response.json({ projects });
  return Response.json({});
}, originalFetch);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { BotPanelView } = await import('./BotPanel');
const originalProjects = useProjectsStore.getState();
const originalSessionUI = useSessionUIStore.getState();
let root: Root;
let renderObserver: MutationObserver | null = null;

beforeEach(() => {
  bot = configuredBot(); items = []; chatsAnswer = null; posts = []; artifactReads = []; chatsReadWaiters = []; artifactReadWaiters = [];
  takeOverAnswer = () => Response.json({});
  useProjectsStore.setState({ projects });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  useSessionUIStore.getState().setCurrentSession('ses_before', '/before');
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  renderObserver?.disconnect(); renderObserver = null;
  await act(async () => root.unmount());
  useProjectsStore.setState(originalProjects, true);
  useSessionUIStore.setState(originalSessionUI, true);
  document.body.replaceChildren();
});
afterAll(async () => { globalThis.fetch = originalFetch; await dom.restore(); });

const text = () => document.body.textContent ?? '';
const waitFor = (ready: () => boolean) => new Promise<void>((resolve) => {
  const observer = new MutationObserver(check);
  renderObserver = observer;
  function check() { if (ready()) { observer.disconnect(); renderObserver = null; resolve(); } }
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  check();
});
const section = (title: string) => {
  const found = [...document.querySelectorAll('section')].find((entry) => entry.querySelector('h2')?.textContent === title);
  if (!found) throw new Error(`Missing section: ${title}`);
  return found;
};
const tile = (title: string) => {
  const found = [...document.querySelectorAll('li')].find((entry) => entry.querySelector('p')?.textContent === title);
  if (!found) throw new Error(`Missing item: ${title}`);
  return found;
};
const button = (within: ParentNode, label: string) => {
  const found = [...within.querySelectorAll('button')].find((entry) => entry.textContent === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return found;
};
const open = async (item: { projectId: string; itemId: string } | null = null) => {
  await act(async () => root.render(<I18nProvider><BotPanelView scope={{ botId: 'bot-1', item }} /></I18nProvider>));
  await waitFor(() => document.querySelector('section') !== null || document.querySelector('[role="alert"]') !== null);
};

describe('Bot panel home', () => {
  test('sets what waits on the person apart from running work and says why each item waits', async () => {
    // Given a bot with a waiting item, a running one and a finished one, on a daily schedule.
    bot = { ...configuredBot(), schedule: { kind: 'daily', time: '09:00', weekdays: [1], cron: '0 9 * * 1-5' } };
    items = [
      workItem({ itemId: 'item-wait', title: 'Raise the token limit', state: 'needs-you', updatedAt: 3,
        wait: { reason: 'BOT_DAILY_TOKEN_BUDGET', since: 1, channel: 'ui', people: [] },
        question: { questionKey: 'question-1', questions: ['Which API version should the parser target?'] } }),
      workItem({ itemId: 'item-work', title: 'Repair parser', state: 'fixing', updatedAt: 2 }),
      workItem({ itemId: 'item-done', title: 'Old cleanup', state: 'done', updatedAt: 1, finishedAt: 1 }),
    ];

    // When the panel opens on Home.
    await open();

    // Then each group holds its own items, with the project, the reason in the app's words and the pending question.
    const waiting = section('Needs you').textContent ?? '';
    expect(waiting).toContain('Raise the token limit');
    expect(waiting).toContain('Parser service');
    expect(waiting).toContain("The bot reached its daily token limit. Raise the limit in the bot's settings or resume tomorrow.");
    expect(waiting).toContain('Which API version should the parser target?');
    expect(waiting).toContain('The bot asks its questions in its chat. Answer there.');
    expect(waiting).not.toContain('Repair parser');
    expect(section('Working').textContent).toContain('Repair parser');
    expect(text()).not.toContain('Old cleanup');
    expect(text()).toContain(bot.name);
    expect(section('Automations').textContent).toContain('Runs every day at 09:00.');
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('names an unknown reason by its code and never repeats the server\'s own words', async () => {
    // Given one item that waits on a code the app has no sentence for, and one whose reason is prose.
    items = [
      workItem({ itemId: 'item-code', title: 'New kind of stop', state: 'needs-you', wait: { reason: 'BOT_SOMETHING_NEW', since: 1, channel: 'ui', people: [] } }),
      workItem({ itemId: 'item-prose', title: 'Merged too early', state: 'needs-you', wait: { reason: 'GitHub merged before revocation was confirmed', since: 1, channel: 'ui', people: [] } }),
    ];

    // When the panel opens.
    await open();

    // Then the code is named, and the prose is replaced by a sentence of the app's own.
    expect(tile('New kind of stop').textContent).toContain('The bot stopped for a reason the app does not know yet (code BOT_SOMETHING_NEW). Open the chat to see what happened.');
    expect(tile('Merged too early').textContent).toContain('The bot stopped and gave no reason the app can explain. Open the chat to see what happened.');
    expect(text()).not.toContain('GitHub merged before revocation was confirmed');
  });

  test('resumes a waiting item and reads the bot\'s work again', async () => {
    // Given an item that needs the person.
    items = [workItem({ itemId: 'item-wait', title: 'Raise the token limit', state: 'needs-you' })];
    await open();

    // When they resume it.
    const reread = nextChatsRead();
    await act(async () => button(tile('Raise the token limit'), 'Resume').click());
    await reread;

    // Then the server was asked to resume that item, in its project.
    expect(posts).toEqual([`${itemsRoute}/item-wait/resume`]);
  });

  test('stops an item only after the person confirms', async () => {
    // Given an item that needs the person.
    items = [workItem({ itemId: 'item-wait', title: 'Raise the token limit', state: 'needs-you' })];
    await open();

    // When they press Stop item.
    await act(async () => button(tile('Raise the token limit'), 'Stop item').click());

    // Then nothing is sent until they confirm.
    expect(posts).toEqual([]);
    expect(tile('Raise the token limit').textContent).toContain('Stop this item? The bot stops working on it.');
    const reread = nextChatsRead();
    await act(async () => button(tile('Raise the token limit'), 'Stop item').click());
    await reread;
    expect(posts).toEqual([`${itemsRoute}/item-wait/stop`]);
  });

  test('takes over a running item and opens the session the server returns', async () => {
    // Given a running item with a checkout, and one without.
    items = [
      workItem({ itemId: 'item-work', title: 'Repair parser', worktree: '/host/project', updatedAt: 2 }),
      workItem({ itemId: 'item-new', title: 'Just admitted', state: 'queued', updatedAt: 1 }),
    ];
    takeOverAnswer = () => Response.json({ item: botItem(), reports: {}, snapshot: null, session: { sessionId: 'ses_taken', directory: '/host/project' } });
    await open();
    expect(button(tile('Just admitted'), 'Take over').disabled).toBe(true);

    // When the person takes over the one with a checkout.
    const opened = new Promise<void>((resolve) => {
      const release = useSessionUIStore.subscribe((state) => { if (state.currentSessionId === 'ses_taken') { release(); resolve(); } });
    });
    await act(async () => button(tile('Repair parser'), 'Take over').click());
    await opened;

    // Then that session is the one on screen.
    expect(posts).toEqual([`${itemsRoute}/item-work/take-over`]);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/host/project');
  });

  test('says a refused take-over failed in the app\'s words and keeps the session on screen', async () => {
    // Given a server that refuses the take-over with its own code and message.
    items = [workItem({ itemId: 'item-work', title: 'Repair parser', worktree: '/host/project' })];
    takeOverAnswer = () => Response.json({ code: 'BOT_INTERNAL', error: 'at takeOver (/srv/bots/runtime.js:12)' }, { status: 500 });
    await open();

    // When the person takes the item over.
    const failed = waitFor(() => tile('Repair parser').querySelector('[role="alert"]') !== null);
    await act(async () => button(tile('Repair parser'), 'Take over').click());
    await failed;

    // Then the item says so without the code, the status or the server's message.
    expect(tile('Repair parser').querySelector('[role="alert"]')?.textContent).toBe('The server did not complete this action. Refresh and try again.');
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_before');
  });

  test('keeps an action running, and its failure, while the person looks at Artifacts', async () => {
    // Given a take-over the server has not answered yet.
    items = [workItem({ itemId: 'item-work', title: 'Repair parser', worktree: '/host/project' })];
    const answer = deferred<Response>();
    takeOverAnswer = () => answer.promise;
    await open();
    await act(async () => button(tile('Repair parser'), 'Take over').click());

    // When the person visits Artifacts and comes back before the answer.
    await act(async () => button(document.body, 'Artifacts').click());
    await act(async () => button(document.body, 'Home').click());

    // Then the action is still the one in flight, so it cannot be sent twice.
    expect(button(tile('Repair parser'), 'Take over').disabled).toBe(true);

    // When the server refuses while Artifacts is shown again.
    await act(async () => button(document.body, 'Artifacts').click());
    const reread = nextChatsRead();
    await act(async () => answer.resolve(Response.json({}, { status: 500 })));
    await reread;
    await act(async () => button(document.body, 'Home').click());

    // Then Home says the take-over failed.
    expect(posts).toEqual([`${itemsRoute}/item-work/take-over`]);
    expect(tile('Repair parser').querySelector('[role="alert"]')?.textContent).toBe('The server did not complete this action. Refresh and try again.');
  });

  test('keeps a failed read apart from a bot with no work and loads it on retry', async () => {
    // Given the bot's work cannot be read.
    chatsAnswer = () => Response.json({ code: 'BOT_HOST_NOT_READY' }, { status: 503 });
    await open();

    // Then the panel says so and claims nothing about the bot's work.
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.querySelector('span')?.textContent).toBe("Could not load this bot's work. Check the connection and try again.");
    expect(text()).not.toContain('Nothing is waiting on you.');
    expect(text()).not.toContain('BOT_HOST_NOT_READY');

    // When the server recovers and the person tries again.
    chatsAnswer = null;
    const loaded = waitFor(() => text().includes('Nothing is waiting on you.'));
    await act(async () => button(document.body, 'Try again').click());
    await loaded;

    // Then the work is shown and the error is gone.
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('Bot panel artifacts', () => {
  test('sets what the bot must present against what it produced for the item of the conversation', async () => {
    // Given a bot that owes two artifacts, and an item where a page names one of them.
    bot = { ...configuredBot(), artifacts: [{ id: 'benchmark', label: 'Benchmark before and after' }, { id: 'risks', label: 'Risk review' }] };
    items = [workItem()];
    await open({ projectId, itemId: 'item-1' });

    // When the person opens Artifacts.
    const listed = waitFor(() => text().includes('Notes on the cache'));
    await act(async () => button(document.body, 'Artifacts').click());
    await listed;

    // Then each requirement says whether it was presented, and every page is listed, named by the requirement it answers.
    const required = [...section('Required artifacts').querySelectorAll('li')].map((entry) => entry.textContent);
    expect(required).toEqual(['Benchmark before and afterPresented', 'Risk reviewPending']);
    const pages = [...section('Pages from the bot').querySelectorAll('li button')].map((entry) => [...entry.querySelectorAll('span')].map((part) => part.textContent));
    expect(pages).toEqual([['Latency before and after', 'Benchmark before and after'], ['Notes on the cache']]);
    expect(artifactReads).toEqual([`${itemsRoute}/item-1/artifacts`]);

    // When the person refreshes the panel.
    const reread = nextArtifactsRead();
    const refresh = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
    await waitFor(() => refresh?.disabled === false);
    await act(async () => refresh?.click());
    await reread;

    // Then the item's pages are read again along with the bot's work.
    expect(artifactReads).toHaveLength(2);
  });

  test('shows the most recent item in the bot\'s main chat', async () => {
    // Given the main chat of a bot with two items.
    items = [
      workItem({ itemId: 'item-old', title: 'Older work', updatedAt: 1 }),
      workItem({ itemId: 'item-new', title: 'Newer work', updatedAt: 5 }),
    ];
    await open();

    // When the person opens Artifacts.
    const listed = waitFor(() => text().includes('Notes on the cache'));
    await act(async () => button(document.body, 'Artifacts').click());
    await listed;

    // Then the pages are those of the item worked on last, which the selector names.
    expect(artifactReads).toEqual([`${itemsRoute}/item-new/artifacts`]);
    expect(document.querySelector('[aria-label="Work item"]')?.textContent).toBe('Newer work');
  });
});
