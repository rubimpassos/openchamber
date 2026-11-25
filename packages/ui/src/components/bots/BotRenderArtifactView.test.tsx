import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import type { JsonValue } from '@/lib/opencode/model';

import {
  ANSWER_PATH, SCOPE, SESSION_ID,
  appears, installRetainedPageStand, loadRetainedPageApp, reportOutstanding, retainedCase,
} from '@/components/chat/message/parts/retainedPage.fixture';
import { htmlRenderAnswerStateMessage } from '@/components/chat/message/parts/htmlRender';

const FORM = 'root = Stack([go])\ngo = Button("Ship it")';
const HTML = '<!doctype html><html><body><button class="oc-button">Ship it</button></body></html>';
const answerSchema = z.object({ sessionId: z.string(), callId: z.string(), summary: z.string() });

const stand = installRetainedPageStand();
const { BotRenderArtifactView } = await import('./BotRenderArtifactView');
let app: Awaited<ReturnType<typeof loadRetainedPageApp>>;
let mounted: { unmount: () => void }[] = [];

const page = retainedCase('e');
type Read = Parameters<typeof page.read>[0];
const open = (read: Read, readOnly: boolean) => {
  stand.serve((url) => {
    if (url.pathname === page.path) return Response.json(page.read(read));
    return url.pathname === ANSWER_PATH ? Response.json({}) : undefined;
  });
  const view = app.mount(<BotRenderArtifactView {...SCOPE} artifactId={page.artifactId} readOnly={readOnly} />);
  mounted.push(view);
  return view.host;
};
const button = (host: HTMLElement) => appears('the page button', () => [...host.querySelectorAll('button')].find((entry) => entry.textContent === 'Ship it'));

/** The page's side of the frame: it posts what a click on the page's own button sends, and keeps the host's replies. */
const pageIn = async (host: HTMLElement) => {
  const frame = await appears('the page frame', () => host.querySelector('iframe'));
  const replies: JsonValue[] = [];
  const pageWindow = { postMessage: (message: JsonValue) => { replies.push(message); } };
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: pageWindow });
  // The host shows a frame once it loaded, in a render that follows the one that attached its listeners.
  frame.dispatchEvent(new Event('load'));
  await appears('the loaded frame', () => (frame.style.opacity === '' ? frame : null));
  return {
    replies,
    submit: () => window.dispatchEvent(Object.assign(new Event('message'), { source: pageWindow, data: {
      jsonrpc: '2.0', id: 7, method: 'ui/message',
      params: { role: 'user', content: [{ type: 'text', text: 'Ship it' }], _meta: { 'openchamber/data': { choice: 'ship' } } },
    } })),
  };
};

beforeAll(async () => { app = await loadRetainedPageApp(); });
afterEach(() => { for (const view of mounted) view.unmount(); mounted = []; app.announceWaiting(null); reportOutstanding(); });
afterAll(async () => { await stand.restore(); });

describe('a retained page in the work record', () => {
  test('shows how its question was settled', async () => {
    // Given a page whose canonical call was answered before the record opened.
    const host = open({
      body: { format: 'ui', content: FORM }, interaction: 'awaitAnswer',
      page: { kind: 'answered', summary: 'Ship it', data: { button: 'Ship it', values: {} } },
    }, false);

    // When the record draws it.
    const status = await appears('the answer line', () => host.querySelector('[data-html-render-status="answered"]'));

    // Then the answer is shown and the form takes no other.
    expect(status.textContent).toContain('Ship it');
    expect((await button(host)).disabled).toBe(true);
  });

  test('opens a question only while the server waits on its call', async () => {
    // Given a snapshot that remembers a waiting question, with no call waiting on the server.
    const host = open({ body: { format: 'ui', content: FORM }, interaction: 'awaitAnswer', page: { kind: 'waiting' } }, false);
    const form = await button(host);
    expect(form.disabled).toBe(true);
    expect(host.querySelector('[data-html-render-status="waiting"]')).toBeNull();

    // When the server announces that the call waits.
    app.announceWaiting(page.callId);

    // Then the page takes an answer.
    expect(await appears('the open form', () => (form.disabled ? null : form))).toBe(form);
  });

  test('sends an answer to the canonical call of the page', async () => {
    // Given a page whose call waits on the server, in the record of an active item.
    app.announceWaiting(page.callId);
    const drawn = await pageIn(open({ body: { format: 'html', content: HTML }, interaction: 'awaitAnswer' }, false));

    // When the page submits.
    const answered = stand.request(ANSWER_PATH);
    drawn.submit();
    await answered;

    // Then the answer names the call that drew the page.
    const sent = stand.requests.find((request) => request.path === ANSWER_PATH);
    expect(answerSchema.parse(JSON.parse(sent?.body ?? ''))).toEqual({ sessionId: SESSION_ID, callId: page.callId, summary: 'Ship it' });
  });

  const waitingPage = { body: { format: 'html', content: HTML }, interaction: 'awaitAnswer' } as const;
  for (const { condition, readOnly, read } of [
    { condition: 'a read-only record', readOnly: true, read: waitingPage },
    { condition: 'a record whose canonical answer state is unavailable', readOnly: false,
      read: { ...waitingPage, pageError: 'BOT_ARTIFACT_PAGE_UNAVAILABLE' as const } },
  ]) test(`never answers from ${condition}`, async () => {
    // Given a waiting call whose record cannot authorize an answer.
    app.announceWaiting(page.callId);
    const host = open(read, readOnly);
    const drawn = await pageIn(host);

    // When the page submits.
    drawn.submit();

    // Then the host refuses at once and sends nothing, and the page was never told it could answer.
    expect(z.array(z.object({ id: z.literal(7), error: z.object({ message: z.string().min(1) }) })).parse(
      drawn.replies.filter((reply) => z.object({ id: z.literal(7) }).safeParse(reply).success),
    )).toHaveLength(1);
    expect(stand.paths()).not.toContain(ANSWER_PATH);
    const told = z.array(z.object({ type: z.literal(htmlRenderAnswerStateMessage({ waiting: false, answer: null }).type), waiting: z.boolean() }))
      .parse(drawn.replies.filter((reply) => z.object({ waiting: z.boolean() }).safeParse(reply).success));
    expect(told.length).toBeGreaterThan(0);
    expect(told.filter((state) => state.waiting)).toEqual([]);
    // The record still says the question is open, for the conversation to answer.
    expect(host.querySelector('[data-html-render-status="waiting"]')).not.toBeNull();
  });
});
