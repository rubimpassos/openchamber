import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
let artifactsFail = false;
// Only the HTTP boundary is replaced; the workspace, parsers and request owners are real.
// Install before module imports so their startup reads use the same test transport.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  if (path.endsWith('/conversation')) { conversationAsks += 1; return Response.json({ code: 'BOT_CONVERSATION_UNAVAILABLE' }, { status: 503 }); }
  if (path.endsWith('/artifacts')) {
    artifactReads += 1;
    return artifactsFail ? Response.json({}, { status: 500 }) : Response.json({ nextOffset: null, artifacts: [
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
let root: Root;

beforeEach(() => {
  item = botItem(); conversationAsks = 0; artifactReads = 0; artifactsFail = false;
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
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
  test('lists the pages the bot drew under the tab of their kind from one read', async () => {
    // Given an item with one evidence page and one decision page.
    await open();
    await act(async () => button('Work context').click());

    // When the user reads Evidence and then Decisions.
    await act(async () => button('Evidence').click());
    const evidence = text();
    await act(async () => button('Decisions').click());

    // Then each tab pairs the server's record with its own pages.
    expect(evidence).toContain(item.proof.reason);
    expect(evidence).not.toContain('Why the cache was rejected');
    expect(text()).toContain('No judge verdict recorded.');
    expect(text()).not.toContain('Latency before and after');
    expect(artifactReads).toBe(1);
  });

  test('keeps a failed page list apart from an empty one', async () => {
    // Given the page list cannot be read.
    artifactsFail = true;
    await open();
    await act(async () => button('Work context').click());

    // When Evidence opens.
    await act(async () => button('Evidence').click());

    // Then the failure is stated, with no claim that the bot drew nothing.
    expect(text()).not.toContain('The bot has not drawn any evidence yet.');
    expect(text()).toContain(item.proof.reason);
  });
});
