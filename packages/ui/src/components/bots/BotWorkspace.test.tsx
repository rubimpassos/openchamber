import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { botItem, configuredBot } from '@/lib/bots/bots.fixture';
import { installSuggestedTasksDom } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const originalFetch = globalThis.fetch;
const artifact = (index: number, kind: 'evidence' | 'decision', title: string) => ({
  id: `artifact_${String(index).repeat(64)}`, title, kind, createdAt: index,
  source: { sessionId: 'ses_stage', callId: `call-${index}`, producer: { role: 'stage', stage: 'investigation' } },
  interaction: 'none', incompleteAssets: [],
});
let item = botItem();
let conversationAsks = 0;
let artifactReads = 0;
let artifactsFail: (() => Response | Promise<Response>) | null = null;
/** One read of a page: whether a dialog stood open when it was asked for, and the signal that retires it. */
let pageReads: { readonly dialogOpen: boolean; readonly signal: AbortSignal | null | undefined }[] = [];
let pageAnswer: (() => Response | Promise<Response>) | null = null;
// Only the HTTP boundary is replaced; the workspace, parsers and request owners are real.
// Install before module imports so their startup reads use the same test transport.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  if (path.includes('/artifacts/')) {
    pageReads.push({ dialogOpen: document.querySelector('[role="dialog"]') !== null, signal: init?.signal });
    return pageAnswer ? pageAnswer() : Response.json({});
  }
  if (path.endsWith('/conversation')) { conversationAsks += 1; return Response.json({ code: 'BOT_CONVERSATION_UNAVAILABLE' }, { status: 503 }); }
  if (path.endsWith('/artifacts')) {
    artifactReads += 1;
    return artifactsFail ? artifactsFail() : Response.json({ nextOffset: null, artifacts: [
      artifact(1, 'evidence', 'Latency before and after'), artifact(2, 'decision', 'Why the cache was rejected'),
    ] });
  }
  if (path.endsWith(`/items/${item.id}`)) return Response.json({ item, reports: {}, snapshot: null });
  if (path === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' });
  return Response.json({});
}, originalFetch);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { BotWorkspace } = await import('./BotWorkspace');
const { useUiBlockComponent } = await import('@/components/chat/uiBlocks/useUiBlockComponent');
let root: Root;
let renderObserver: MutationObserver | null = null;
let rendererLoad: { mockRestore: () => void } | null = null;

beforeEach(() => {
  item = botItem(); conversationAsks = 0; artifactReads = 0; artifactsFail = null; pageReads = []; pageAnswer = null;
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  renderObserver?.disconnect(); renderObserver = null; rendererLoad?.mockRestore(); rendererLoad = null;
  await act(async () => root.unmount()); document.body.replaceChildren();
});
afterAll(async () => { globalThis.fetch = originalFetch; await dom.restore(); });

const button = (label: string) => {
  const element = [...document.querySelectorAll('button')].find((entry) => entry.textContent === label || entry.getAttribute('aria-label') === label);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return element;
};
const open = async () => {
  await act(async () => root.render(<I18nProvider><BotWorkspace projectId="project-1" bot={configuredBot()} initial={item} archived={false} layout="mobile" onBack={() => {}} onLeave={() => {}} /></I18nProvider>));
};
const text = () => document.body.textContent ?? '';
const pageRow = (title: string) => {
  const element = [...document.querySelectorAll('[data-bot-context-body] li button')].find((entry) => entry.textContent?.startsWith(title));
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing page row: ${title}`);
  return element;
};
const waitFor = (ready: () => boolean) => new Promise<void>((resolve) => {
  const observer = new MutationObserver(check);
  renderObserver = observer;
  function check() { if (ready()) { observer.disconnect(); renderObserver = null; resolve(); } }
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  check();
});

describe('Bot item conversation', () => {
  test('reports a conversation the server cannot open and asks again only on retry', async () => {
    // Given an active item whose investigation stage already runs, and a server that cannot open its conversation.
    item = botItem({ state: 'investigating', sessions: { investigation: 'ses_stage' } });
    await open();
    expect(conversationAsks).toBe(1);

    // When the user retries.
    await act(async () => button('Try again').click());

    // Then the stage session never stands in for the missing conversation.
    expect(document.querySelector('[data-chat-column]')).toBeNull();
  });

  test('does not ask for a conversation once the item has ended', async () => {
    // Given an item that finished before conversations existed.
    item = botItem({ state: 'done', finishedAt: 2 });

    // When it opens.
    await open();

    // Then nothing is created for it.
    expect(conversationAsks).toBe(0);
  });
});

describe('Bot work context', () => {
  test('lists every page the bot drew in one Artifacts tab beside the recorded proof and verdict, from one read', async () => {
    // Given an item with one evidence page and one decision page.
    await open();
    await act(async () => button('Work context').click());

    // When the user opens Artifacts.
    await act(async () => button('Artifacts').click());

    // Then both pages are listed whatever their kind, with the server's record under them.
    expect(pageRow('Latency before and after')).toBeTruthy();
    expect(pageRow('Why the cache was rejected')).toBeTruthy();
    expect(text()).toContain(item.proof.reason);
    expect(text()).toContain('No judge verdict recorded.');
    expect(artifactReads).toBe(1);
  });

  test('returns focus to the page row when its dialog closes', async () => {
    // Given a reader in Artifacts whose focus rests on another control, as it stays on the composer after a press that moves no focus.
    await open();
    await act(async () => button('Work context').click());
    await act(async () => button('Artifacts').click());
    button('Artifacts').focus();
    const row = pageRow('Why the cache was rejected');

    // When the page opens from its row and Escape closes it.
    const appeared = waitFor(() => document.querySelector('[role="dialog"]') !== null);
    await act(async () => row.click());
    await appeared;
    const dialog = document.querySelector('[role="dialog"]');
    const closed = waitFor(() => document.querySelector('[role="dialog"]') === null);
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await closed;
    await act(async () => {});

    // Then focus is on the row that opened the page.
    expect(document.activeElement === row).toBe(true);
  });

  const openArtifacts = async () => {
    await open();
    await act(async () => button('Work context').click());
    await act(async () => button('Artifacts').click());
    return pageRow('Why the cache was rejected');
  };
  const openDialog = () => document.querySelector('[role="dialog"]');
  const stagedPopup = () => document.querySelector('[data-slot="dialog-content"]');
  const refused = () => Response.json({}, { status: 500 });
  const heldAnswer = () => {
    let answer: (response: Response) => void = () => {};
    pageAnswer = () => new Promise<Response>((resolve) => { answer = resolve; });
    return (response: Response) => act(async () => answer(response));
  };

  test('prepares a page out of sight beside its row and opens the dialog on what it prepared', async () => {
    // Given a page whose read is still in flight after its row was pressed.
    const answer = heldAnswer();
    const row = await openArtifacts();
    const staging = waitFor(() => stagedPopup()?.querySelector('[data-retained-page="pending"]') != null);
    await act(async () => row.click());
    await staging;
    const staged = stagedPopup();

    // Then the row says it is loading and offers Cancel, and no dialog is open over the page.
    expect(row.closest('li')?.querySelector('[role="status"]')?.textContent).toBe('Loading...');
    expect(row.closest('li')?.textContent).toContain('Cancel');
    expect(openDialog()).toBeNull();
    expect(staged?.hasAttribute('inert')).toBe(true);
    expect(document.documentElement.classList.contains('oc-dialog-open')).toBe(false);

    // When the read settles and its content is laid out.
    const opened = waitFor(() => openDialog() !== null);
    await answer(refused());
    await opened;

    // Then the dialog is the popup that was prepared, showing what the read gave, and the row is back to rest.
    expect(openDialog() === staged).toBe(true);
    expect(openDialog()?.querySelector('[data-retained-page="failed"]')).not.toBeNull();
    expect(row.closest('li')?.textContent).not.toContain('Cancel');
  });

  test('drops a page cancelled while it was being prepared', async () => {
    // Given a page being prepared from its row.
    const answer = heldAnswer();
    const row = await openArtifacts();
    const staging = waitFor(() => stagedPopup()?.querySelector('[data-retained-page="pending"]') != null);
    await act(async () => row.click());
    await staging;
    await act(async () => {});

    // When the reader cancels and the read answers late.
    await act(async () => button('Cancel').click());
    await answer(refused());

    // Then the read is retired, nothing prepared remains, no dialog opens and focus is back on the row.
    expect(pageReads[0]?.signal?.aborted).toBe(true);
    expect(stagedPopup()).toBeNull();
    expect(openDialog()).toBeNull();
    expect(row.closest('li')?.textContent).not.toContain('Cancel');
    expect(document.activeElement === row).toBe(true);
  });

  test('asks again for a failed page only after its dialog has closed, and opens it once prepared', async () => {
    // Given a page whose read failed, shown in its dialog.
    pageAnswer = refused;
    const row = await openArtifacts();
    const shown = waitFor(() => openDialog() !== null);
    await act(async () => row.click());
    await shown;

    // When the reader tries again from the dialog.
    const reopened = waitFor(() => pageReads.length === 2 && openDialog() !== null);
    await act(async () => [...(openDialog()?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent === 'Try again')?.click());
    await reopened;

    // Then neither read was asked for under an open dialog, whose size the answer would change.
    expect(pageReads.map((read) => read.dialogOpen)).toEqual([false, false]);
  });

  test('ends the preparation of a page whose renderer cannot load, says so by the list, and tries again from its row', async () => {
    // Given a UI page whose renderer chunk does not load.
    const load = spyOn(useUiBlockComponent, 'load').mockImplementation(async () => { throw new Error('The renderer chunk did not load'); });
    rendererLoad = load;
    pageAnswer = () => Response.json({
      artifact: artifact(2, 'decision', 'Why the cache was rejected'),
      payload: { version: 1, body: { format: 'ui', content: 'root = Stack([go])\ngo = Button("Ship it")' }, assets: [] },
    });
    const row = await openArtifacts();
    const saysViewFailed = () => [...document.querySelectorAll('[data-bot-context-body] [role="alert"]')]
      .some((entry) => entry.textContent === 'Could not open this page. Try again.');

    // When its row is pressed.
    const failed = waitFor(saysViewFailed);
    await act(async () => row.click());
    await failed;

    // Then nothing is left being prepared and no dialog opened on the page's source.
    expect(stagedPopup()).toBeNull();
    expect(openDialog()).toBeNull();
    expect(row.closest('li')?.textContent).not.toContain('Cancel');

    // When the reader presses the row again.
    const again = waitFor(() => load.mock.calls.length === 2 && saysViewFailed());
    await act(async () => row.click());
    await again;

    // Then the page was read and its renderer asked for once more.
    expect(pageReads).toHaveLength(2);
  });

  for (const { cause, says, refuse } of [
    { cause: 'the server fails', says: 'Could not load the pages.', refuse: () => Response.json({}, { status: 500 }) },
    { cause: 'the server is not ready', says: 'The server cannot show the bot\'s pages right now. Try again in a moment.',
      refuse: () => Response.json({ code: 'BOT_EXECUTION_NOT_READY', error: 'at list (/srv/bots/artifacts-owner.js:12)' }, { status: 503 }) },
    { cause: 'the server cannot be reached', says: 'Could not reach the server. Check the connection and try again.',
      refuse: () => Promise.reject<Response>(new TypeError('fetch failed: https://internal.example/artifacts?token=secret')) },
  ]) test(`keeps a page list apart from an empty one and names the cause when ${cause}`, async () => {
    // Given the page list cannot be read.
    artifactsFail = refuse;
    await open();
    await act(async () => button('Work context').click());

    // When Artifacts opens.
    await act(async () => button('Artifacts').click());

    // Then the cause is stated in the app's own words, with no claim that the bot drew nothing.
    const alert = document.querySelector('[data-bot-context-body] [role="alert"]');
    expect(alert?.querySelector('span')?.textContent).toBe(says);
    expect(text()).not.toContain('The bot has not produced any artifacts for this item yet.');
    expect(text()).toContain(item.proof.reason);

    // When the server recovers and the reader tries again.
    const reads = artifactReads;
    artifactsFail = null;
    await act(async () => alert?.querySelector('button')?.click());

    // Then one more read lists the pages.
    expect(artifactReads).toBe(reads + 1);
    expect(text()).toContain('Latency before and after');
  });
});
