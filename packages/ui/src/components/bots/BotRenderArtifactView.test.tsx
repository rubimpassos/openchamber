import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';

import type React from 'react';

import type { JsonValue } from '@/lib/opencode/model';

import {
  ANSWER_PATH, SCOPE, SESSION_ID,
  appears, installRetainedPageStand, loadRetainedPageApp, reportOutstanding, retainedCase,
} from '@/components/chat/message/parts/retainedPage.fixture';
import { clampHtmlRenderHeight, htmlRenderAnswerStateMessage } from '@/components/chat/message/parts/htmlRender';

const FORM = 'root = Stack([go])\ngo = Button("Ship it")';
const HTML = '<!doctype html><html><body><button class="oc-button">Ship it</button></body></html>';
const answerSchema = z.object({ sessionId: z.string(), callId: z.string(), summary: z.string() });

const stand = installRetainedPageStand();
const { BotRenderArtifactView } = await import('./BotRenderArtifactView');
const { useUiBlockComponent } = await import('@/components/chat/uiBlocks/useUiBlockComponent');
let app: Awaited<ReturnType<typeof loadRetainedPageApp>>;
let mounted: { unmount: () => void }[] = [];

const page = retainedCase('e');
type Read = Parameters<typeof page.read>[0];
type Staging = Pick<React.ComponentProps<typeof BotRenderArtifactView>, 'preparing' | 'onReady' | 'onLoadFailed' | 'onRetry'>;
const draw = (readOnly: boolean, staging: Staging = {}) => {
  const view = app.mount(<BotRenderArtifactView {...SCOPE} artifactId={page.artifactId} readOnly={readOnly} {...staging} />);
  mounted.push(view);
  return view.host;
};
const open = (read: Read, readOnly: boolean, staging?: Staging) => {
  stand.serve((url) => {
    if (url.pathname === page.path) return Response.json(page.read(read));
    return url.pathname === ANSWER_PATH ? Response.json({}) : undefined;
  });
  return draw(readOnly, staging);
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

let rendererLoad: { mockRestore: () => void } | null = null;
/** The UI renderer's chunk as a view asks for it: held until the test lets it arrive or fail. */
const holdRenderer = async () => {
  const renderer = await useUiBlockComponent.load();
  let settle = { arrive: () => {}, fail: () => {} };
  let asked: () => void = () => {};
  const requested = new Promise<void>((resolve) => { asked = resolve; });
  rendererLoad = spyOn(useUiBlockComponent, 'load').mockImplementation(() => new Promise((resolve, reject) => {
    settle = { arrive: () => resolve(renderer), fail: () => reject(new Error('The renderer chunk did not load')) };
    asked();
  }));
  return { requested, arrive: () => settle.arrive(), fail: () => settle.fail() };
};

beforeAll(async () => { app = await loadRetainedPageApp(); });
afterEach(() => {
  for (const view of mounted) view.unmount();
  mounted = []; app.announceWaiting(null); rendererLoad?.mockRestore(); rendererLoad = null; reportOutstanding();
});
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

  test('refuses an answer while its dialog is still being prepared, laid out as the open question it will show', async () => {
    // Given a waiting call whose page is drawn out of sight before its dialog opens.
    app.announceWaiting(page.callId);
    const host = open(waitingPage, false, { preparing: true });
    const drawn = await pageIn(host);

    // When the page submits before anyone can see it.
    drawn.submit();

    // Then the host refuses and sends nothing.
    expect(z.array(z.object({ id: z.literal(7), error: z.object({ message: z.string().min(1) }) })).parse(
      drawn.replies.filter((reply) => z.object({ id: z.literal(7) }).safeParse(reply).success),
    )).toHaveLength(1);
    expect(stand.paths()).not.toContain(ANSWER_PATH);
    // The page keeps the size of an open question: it is told it may answer and no read-only note is added.
    const told = z.array(z.object({ waiting: z.boolean() }))
      .parse(drawn.replies.filter((reply) => z.object({ waiting: z.boolean() }).safeParse(reply).success));
    expect(told.some((state) => state.waiting)).toBe(true);
    expect(host.textContent).not.toContain('Read-only view.');
  });
});

describe('a retained page staged for its dialog', () => {
  const readiness = () => {
    const seen: string[] = [];
    let host: HTMLElement | null = null;
    let notify: (value: string[]) => void = () => {};
    const reported = new Promise<string[]>((resolve) => { notify = resolve; });
    return {
      seen, watch: (drawn: HTMLElement) => { host = drawn; },
      onReady: () => { seen.push(host?.querySelector('iframe')?.style.height ?? host?.textContent ?? ''); notify(seen); },
      reported: () => reported,
    };
  };

  for (const example of [
    { name: 'flow content', html: HTML, reported: 180.2, viewport: 240, expected: 181 },
    { name: 'fixed-position content', html: '<div style="position:fixed;inset:0">Hello</div>', reported: 0, viewport: 240, expected: 240 },
  ] as const) test(`reports ${example.name} at its usable height, never when its frame loads`, async () => {
    // Given an HTML page staged at a provisional height.
    const staged = readiness();
    const host = open({ body: { format: 'html', content: example.html } }, false, staged);
    staged.watch(host);
    const frame = await appears('the page frame', () => host.querySelector('iframe'));
    const pageWindow = { postMessage: () => {} };
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: pageWindow });
    Object.defineProperty(frame, 'clientHeight', { configurable: true, value: example.viewport });

    // When the frame loads, and then the page reports its content height.
    frame.dispatchEvent(new Event('load'));
    await appears('the loaded frame', () => (frame.style.opacity === '' ? frame : null));
    const beforeMeasure = [...staged.seen];
    window.dispatchEvent(Object.assign(new Event('message'), { source: pageWindow, data: { type: 'openchamber:html-render:size', height: example.reported } }));
    await staged.reported();

    // Then the one report came after the measure, with the frame already at that height.
    expect(beforeMeasure).toEqual([]);
    expect(staged.seen).toEqual([`${clampHtmlRenderHeight(example.expected)}px`]);
  });

  test('reports a UI page only once its renderer has loaded and drawn it', async () => {
    // Given a UI page staged for its dialog while the renderer's chunk is still loading.
    const renderer = await holdRenderer();
    const staged = readiness();
    const host = open({ body: { format: 'ui', content: FORM } }, false, staged);
    staged.watch(host);
    const record = await appears('the page record', () => host.querySelector('[data-bot-render-artifact]'));

    // Then nothing is reported and the page's source is not drawn in the renderer's place.
    expect(staged.seen).toEqual([]);
    await renderer.requested;
    expect(record.querySelector('[data-ui-render-part]')).toBeNull();

    // When the renderer arrives.
    renderer.arrive();
    await staged.reported();

    // Then the one report saw the drawn page.
    expect(staged.seen).toHaveLength(1);
    expect(staged.seen[0]).toContain('Ship it');
  });

  test('leaves a UI page whose renderer cannot load to its owner and reports nothing', async () => {
    // Given a UI page staged for an owner that handles a renderer that does not load.
    const renderer = await holdRenderer();
    const staged = readiness();
    let tell: () => void = () => {};
    const told = new Promise<void>((resolve) => { tell = resolve; });
    const host = open({ body: { format: 'ui', content: FORM } }, false, { onReady: staged.onReady, onLoadFailed: tell });
    staged.watch(host);
    const record = await appears('the page record', () => host.querySelector('[data-bot-render-artifact]'));
    expect(staged.seen).toEqual([]);
    await renderer.requested;

    // When the chunk fails.
    renderer.fail();
    await told;

    // Then the owner was told, and the view neither reported a page nor drew its source instead.
    expect(staged.seen).toEqual([]);
    expect(record.querySelector('[data-ui-render-part]')).toBeNull();
  });

  test('reports a failed read only once its error is laid out, and leaves the retry to the owner', async () => {
    // Given a read that is still in flight.
    const staged = readiness();
    const retries: (() => void)[] = [];
    let answer: (response: Response) => void = () => {};
    stand.serve((url) => (url.pathname === page.path ? new Promise<Response>((resolve) => { answer = resolve; }) : undefined));
    const read = stand.request(page.path);
    const host = draw(false, { onReady: staged.onReady, onRetry: (retry) => { retries.push(retry); } });
    staged.watch(host);
    await read;
    const whileLoading = [...staged.seen];

    // When the read fails and the reader asks again.
    answer(Response.json({}, { status: 500 }));
    await staged.reported();
    const retry = await appears('the retry button', () => host.querySelector<HTMLButtonElement>('[data-retained-page="failed"] button'));
    retry.click();

    // Then loading reported nothing, the error did, and the second read waits for the owner.
    expect(whileLoading).toEqual([]);
    expect(staged.seen).toHaveLength(1);
    expect(staged.seen[0]).toContain('Could not open this page.');
    expect(retries).toHaveLength(1);
    expect(stand.paths().filter((path) => path === page.path)).toHaveLength(1);

    // When the owner lets the retry run.
    const asked = stand.request(page.path);
    retries[0]?.();
    await asked;

    // Then the page is read again.
    expect(stand.paths().filter((path) => path === page.path)).toHaveLength(2);
  });
});
