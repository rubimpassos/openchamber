import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { useLayoutEffect, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { z } from 'zod';
import type { Metadata, Session, ToolPart } from '@/lib/opencode/model';
import { useSyncRuntime } from '@/sync/sync-runtime-context';

import {
  GRANT_PATH, PLOT_DATA_URL, RAW_PATH, SCOPE, SESSION_ID,
  appears, conversationSession, installRetainedPageStand, loadRetainedPageApp, reportOutstanding, retainedCase,
} from './retainedPage.fixture';

// The page names one image the owner retained, one whose file was already gone
// at capture, and one on another host. Its script asks the network on its own.
const HTML = '<!doctype html><html><head><title>Latency</title></head><body>'
  + '<img id="plot" src="/repo/plot.png"><img id="gone" src="/repo/gone.png"><img id="remote" src="https://cdn.example/x.png">'
  + '<script>fetch("https://cdn.example/beacon")</script></body></html>';
const UI = 'root = Stack([plot])\nplot = Text("![plot](/repo/plot.png)")';
const UNOPENED = 'Could not open this page. Try again.';
const MISSING = [{ source: '/repo/gone.png', status: 'missing' }, { source: 'https://cdn.example/x.png', status: 'external' }] as const;

const stand = installRetainedPageStand();
const { ShownPage } = await import('./ShownPage');
const { BotRenderArtifactView } = await import('@/components/bots/BotRenderArtifactView');
let app: Awaited<ReturnType<typeof loadRetainedPageApp>>;
let mounted: { unmount: () => void }[] = [];
const mount = (node: React.ReactNode) => {
  const view = app.mount(node);
  mounted.push(view);
  return view;
};
const frame = (host: HTMLElement) => appears('the page frame', () => host.querySelector('iframe'));
const plotOf = (srcdoc: string) => new DOMParser().parseFromString(srcdoc, 'text/html').querySelector('#plot')?.getAttribute('src');
const pendingNotice = (host: HTMLElement) => appears('the pending notice', () => host.querySelector('[data-retained-page="pending"]'));
const failureNotice = (host: HTMLElement) => appears('the failure notice', () => host.querySelector('[data-retained-page="failed"]'));
/** Every part of a page a host can mount: the HTML frame and the UI block. */
const drawn = (host: HTMLElement) => [...host.querySelectorAll('iframe, [data-ui-render-part]')];
/** Every read a page can cause: the owner's snapshot, the live image grant and file, and the call's message. */
const reads = (owner: string) => stand.paths().filter((path) => path === owner || path === GRANT_PATH || path === RAW_PATH
  || /^\/api\/session\/[^/]+\/message/.test(path));
/** The call while its page waits for an answer: the one running call a transcript draws. */
const running = (call: ToolPart, metadata?: Metadata): ToolPart => {
  const input = { ...call.state.input, awaitAnswer: true };
  return { ...call, state: metadata
    ? { status: 'running', input, metadata, time: { start: 1 } }
    : { status: 'running', input, time: { start: 1 } } };
};
function ScopedSession({ session, children }: { readonly session?: Session; readonly children: ReactNode }) {
  const { childStores } = useSyncRuntime();
  useLayoutEffect(() => {
    childStores.ensureChild('/repo', { bootstrap: false }).setState({ session: session ? [session] : [] });
  }, [childStores, session]);
  return children;
}
// The policy governs only what the parser meets after it, so it stands ahead of everything the page wrote but its doctype.
const policyOf = (srcdoc: string) => {
  const policy = /^<!doctype html><meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(srcdoc)?.[1];
  if (policy === undefined) throw new Error('The page does not open with its policy');
  return new Map(policy.split(';').map((directive) => {
    const [name = '', ...sources] = directive.trim().split(/\s+/);
    return [name, sources] as const;
  }));
};

beforeAll(async () => { app = await loadRetainedPageApp(); });
afterEach(() => { for (const view of mounted) view.unmount(); mounted = []; reportOutstanding(); });
afterAll(async () => { await stand.restore(); });

describe('a page the bot drew, in its conversation', () => {
  for (const modal of [true, false]) test(`relays Escape from a retained frame only inside a dialog: ${modal}`, async () => {
    const page = retainedCase(modal ? 'e1' : 'e2');
    const keys: string[] = [];
    stand.serve((url) => url.pathname === page.path
      ? Response.json(page.read({ body: { format: 'html', content: '<p>Retained document</p>' } }))
      : undefined);
    const view = mount(<div role={modal ? 'dialog' : undefined} onKeyDown={(event) => keys.push(event.key)}>
      <BotRenderArtifactView {...SCOPE} artifactId={page.artifactId} />
    </div>);
    const documentFrame = await frame(view.host);
    flushSync(() => { documentFrame.dispatchEvent(new Event('load')); });
    window.dispatchEvent(new MessageEvent('message', { source: documentFrame.contentWindow, data: {
      type: 'openchamber:html-render:key', key: 'Escape', code: 'Escape',
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false,
    } }));
    expect(keys).toEqual(modal ? ['Escape'] : []);
  });

  for (const { status, digit } of [
    { status: 'running', digit: 'f' },
    { status: 'error', digit: '0' },
    { status: 'completed', digit: '1' },
  ] as const) test(`uses capture metadata while the call is ${status} without loading its message`, async () => {
    const page = retainedCase(digit);
    const read = page.read({ body: { format: 'html', content: HTML }, interaction: 'awaitAnswer' });
    const captured = { ...read.artifact, incompleteAssets: [...read.artifact.incompleteAssets], publication: 'captured' };
    const result: Metadata = { artifact: captured };
    if (status === 'completed') result.ok = true;
    const metadata = { openchamber: result, openchamberContentShell: { chars: 1000 } };
    const call = page.call({ html: HTML });
    const input = { ...call.state.input, awaitAnswer: true };
    const part: ToolPart = { ...call, state: status === 'running'
      ? { status, input, metadata, time: { start: 1 } }
      : status === 'error'
        ? { status, input, metadata, error: 'Interrupted', time: { start: 1, end: 2 } }
        : { status, input, metadata, output: '', time: { start: 1, end: 2 } } };
    app.openSession(conversationSession(true));
    stand.serve((url) => url.pathname === page.path ? Response.json(read) : undefined);

    const markup = (await frame(mount(<ShownPage part={part} />).host)).srcdoc;

    expect(plotOf(markup)).toBe(PLOT_DATA_URL);
    expect(reads(page.path)).toEqual([page.path]);
  });

  test('draws the retained bytes and reads no file, where the record draws the same document', async () => {
    // Given a bot conversation whose render call names a retained page, with the original files gone.
    const page = retainedCase('a');
    app.openSession(conversationSession(true));
    stand.serve((url) => (url.pathname === page.path
      ? Response.json(page.read({ body: { format: 'html', content: HTML }, missing: MISSING })) : undefined));

    // When the transcript draws the call and the work record opens the same page.
    const chat = mount(<ShownPage part={page.call({ html: HTML })} />).host;
    const native = (await frame(chat)).srcdoc;
    const record = (await frame(mount(<BotRenderArtifactView {...SCOPE} artifactId={page.artifactId} readOnly />).host)).srcdoc;

    // Then the captured image is its retained bytes, and nothing was read from the machine.
    const drawn = new DOMParser().parseFromString(native, 'text/html');
    expect(drawn.querySelector('#plot')?.getAttribute('src')).toBe(PLOT_DATA_URL);
    expect(stand.paths()).not.toContain(GRANT_PATH);
    expect(stand.paths()).not.toContain(RAW_PATH);
    // The files the snapshot does not hold are named, and no source lets the page reach for them.
    expect(drawn.querySelector('#gone')?.getAttribute('src')).toBe('/repo/gone.png');
    expect([...chat.querySelectorAll('[data-retained-page-incomplete] li')].map((entry) => entry.textContent))
      .toEqual(['/repo/gone.png', 'https://cdn.example/x.png']);
    const policy = policyOf(native);
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('img-src')).toEqual(['data:', 'blob:']);
    expect(policy.has('connect-src')).toBe(false);
    expect([...policy.values()].flat().filter((source) => /^(?:https?:|wss?:|\*|'self')/.test(source))).toEqual([]);
    // And both views show one document.
    expect(record).toBe(native);
  });

  test('draws a Markdown image in a UI page from its retained bytes', async () => {
    // Given a retained UI page whose text names a local image.
    const page = retainedCase('b');
    app.openSession(conversationSession(true));
    stand.serve((url) => (url.pathname === page.path
      ? Response.json(page.read({ body: { format: 'ui', content: UI } })) : undefined));

    // When the transcript and the record draw it.
    const chat = mount(<ShownPage part={page.call({ ui: UI })} />).host;
    const record = mount(<BotRenderArtifactView {...SCOPE} artifactId={page.artifactId} readOnly />).host;
    const image = (host: HTMLElement) => appears('the retained image', () => host.querySelector('img[src^="data:"]'));

    // Then each shows the retained bytes, and neither the path nor a grant was requested.
    expect((await image(chat)).getAttribute('src')).toBe(PLOT_DATA_URL);
    expect((await image(record)).getAttribute('src')).toBe(PLOT_DATA_URL);
    expect(document.querySelector('img[src="/repo/plot.png"]')).toBeNull();
    expect(stand.paths()).not.toContain(GRANT_PATH);
  });

  test('draws nothing of a running call until its capture is recorded', async () => {
    // Given a bot conversation whose render call runs and names no retained page yet.
    const page = retainedCase('2');
    const call = page.call({ html: HTML });
    app.openSession(conversationSession(true));
    stand.serve((url) => (url.pathname === page.path
      ? Response.json(page.read({ body: { format: 'html', content: HTML } })) : undefined));

    // When the transcript draws the call.
    const view = mount(<ShownPage part={running(call)} />);

    // Then it waits for the capture and mounts no part of the page.
    await pendingNotice(view.host);
    expect(drawn(view.host)).toEqual([]);

    // When the capture is recorded on the call.
    view.update(<ShownPage part={running(call, page.captured)} />);

    // Then the retained bytes draw, and the owner's read is all the page ever asked for.
    expect(plotOf((await frame(view.host)).srcdoc)).toBe(PLOT_DATA_URL);
    expect(reads(page.path)).toEqual([page.path]);
  });

  test('holds a captured page back until its session is known to be the bot\'s', async () => {
    // Given a captured call whose session the session list has not delivered yet.
    const page = retainedCase('3');
    app.forgetSession();
    stand.serve((url) => (url.pathname === page.path
      ? Response.json(page.read({ body: { format: 'html', content: HTML } })) : undefined));

    // When the transcript draws the call.
    const view = mount(<ShownPage part={running(page.call({ html: HTML }), page.captured)} />);

    // Then the page waits: a captured page is never drawn as an ordinary one.
    await pendingNotice(view.host);
    expect(drawn(view.host)).toEqual([]);

    // When the session arrives with its bot marker.
    app.openSession(conversationSession(true));

    // Then the retained bytes draw from the owner's read alone.
    expect(plotOf((await frame(view.host)).srcdoc)).toBe(PLOT_DATA_URL);
    expect(reads(page.path)).toEqual([page.path]);
  });

  test('waits for the scoped bot session before capture when the global list has not arrived', async () => {
    const page = retainedCase('9');
    const html = '<p>Before capture</p><script>fetch("https://cdn.example/beacon")</script>';
    const call = page.call({ html });
    const read = page.read({ body: { format: 'html', content: html }, interaction: 'awaitAnswer' });
    const snapshot = { ...read, payload: { ...read.payload, assets: [] } };
    const captured: Metadata = { openchamber: {
      artifact: { ...snapshot.artifact, incompleteAssets: [], publication: 'captured' },
    } };
    app.forgetSession();
    stand.serve((url) => url.pathname === page.path ? Response.json(snapshot) : undefined);

    const view = mount(<ScopedSession><ShownPage part={running(call)} /></ScopedSession>);
    await pendingNotice(view.host);
    expect(drawn(view.host)).toEqual([]);
    view.update(<ScopedSession session={conversationSession(true)}><ShownPage part={running(call, captured)} /></ScopedSession>);

    const document = new DOMParser().parseFromString((await frame(view.host)).srcdoc, 'text/html');
    expect(document.querySelector('p')?.textContent).toBe('Before capture');
    expect(reads(page.path)).toEqual([page.path]);
  });

  test('draws an ordinary page once its scoped session arrives without a global record', async () => {
    const page = retainedCase('e');
    app.forgetSession();
    stand.serve(() => undefined);
    const part = running(page.call({ html: HTML }));
    const view = mount(<ScopedSession><ShownPage part={part} /></ScopedSession>);
    await pendingNotice(view.host);
    expect(drawn(view.host)).toEqual([]);

    const granted = stand.request(GRANT_PATH);
    view.update(<ScopedSession session={conversationSession(false)}><ShownPage part={part} /></ScopedSession>);

    expect(await granted).toBe(GRANT_PATH);
    expect(stand.paths()).not.toContain(page.path);
  });

  test('draws nothing of the page while the owner\'s read is pending', async () => {
    // Given a bot conversation whose owner has not answered the read yet.
    const page = retainedCase('4');
    let answer: (response: Response) => void = () => {};
    const answered = new Promise<Response>((resolve) => { answer = resolve; });
    app.openSession(conversationSession(true));
    stand.serve((url) => (url.pathname === page.path ? answered : undefined));

    // When the transcript draws the call.
    const asked = stand.request(page.path);
    const view = mount(<ShownPage part={page.call({ ui: UI })} />);
    await asked;

    // Then the program the call wrote is not drawn in the meantime.
    await pendingNotice(view.host);
    expect(drawn(view.host)).toEqual([]);

    // When the owner answers.
    answer(Response.json(page.read({ body: { format: 'ui', content: UI } })));

    // Then the retained page draws, having read nothing but the snapshot.
    const image = await appears('the retained image', () => view.host.querySelector('img[src^="data:"]'));
    expect(image.getAttribute('src')).toBe(PLOT_DATA_URL);
    expect(reads(page.path)).toEqual([page.path]);
  });

  const signIn = { headers: { 'content-type': 'text/html' } };
  for (const { cause, digit, says, refuse } of [
    { cause: 'fails', digit: 'c', says: UNOPENED, refuse: () => Response.json({}, { status: 500 }) },
    { cause: 'answers with another call\'s page', digit: '5', says: UNOPENED, refuse: (read: ReturnType<ReturnType<typeof retainedCase>['read']>) => Response.json(
      { ...read, artifact: { ...read.artifact, source: { ...read.artifact.source, callId: 'call-other' } } },
    ) },
    { cause: 'is redirected to a sign-in page', digit: 'c2', says: UNOPENED, refuse: () => new Response('<html>Sign in</html>', { ...signIn, status: 302 }) },
    { cause: 'answers with a web page', digit: 'c3', says: UNOPENED, refuse: () => new Response('<html>Sign in</html>', signIn) },
    { cause: 'is refused by a server that is not ready', digit: 'c0', says: 'The server cannot show the bot\'s pages right now. Try again in a moment.',
      refuse: () => Response.json({ code: 'BOT_EXECUTION_NOT_READY', error: 'at read (/srv/bots/artifacts-owner.js:41)' }, { status: 503 }) },
    { cause: 'never reaches the server', digit: 'c1', says: 'Could not reach the server. Check the connection and try again.',
      refuse: () => Promise.reject<Response>(new TypeError('fetch failed: https://internal.example/artifacts?token=secret')) },
  ]) test(`shows a failure and reads nothing live when the owner's read ${cause}`, async () => {
    // Given a bot conversation whose owner cannot give this call's snapshot.
    const page = retainedCase(digit);
    const read = page.read({ body: { format: 'html', content: HTML } });
    let recovered = false;
    app.openSession(conversationSession(true));
    stand.serve((url) => {
      if (url.pathname !== page.path) return undefined;
      return recovered ? Response.json(read) : refuse(read);
    });

    // When the transcript draws the call.
    const view = mount(<ShownPage part={page.call({ html: HTML })} />);

    // Then it names the cause in the app's own words and mounts no part of the page the call wrote.
    const failure = await failureNotice(view.host);
    expect(failure.querySelector('p')?.textContent).toBe(says);
    expect(drawn(view.host)).toEqual([]);

    // When the owner recovers and the reader tries again.
    recovered = true;
    failure.querySelector('button')?.click();

    // Then the retry reads the owner again and draws the retained bytes. No file was read at any point.
    expect(plotOf((await frame(view.host)).srcdoc)).toBe(PLOT_DATA_URL);
    expect(reads(page.path)).toEqual([page.path, page.path]);
  });

  test('shares a retained page from its retained bytes, with no file read', async () => {
    // Given a bot's shared page whose link still needs its document, with the original image gone.
    const page = retainedCase('8');
    const call = page.call({ html: HTML });
    const part: ToolPart = { ...call, state: {
      status: 'completed', input: { ...call.state.input, share: { recipients: ['Ana'] } }, output: '', time: { start: 1, end: 2 },
      metadata: { ...page.captured, openchamber: { ...page.captured.openchamber, ok: true } },
    } };
    const sharePath = `/api/openchamber/sessions/${SESSION_ID}/share-pages/${page.callId}`;
    const group = { title: 'Latency', kind: 'evidence', expectAnswer: false, documentState: 'preparing', recipients: [] };
    app.openSession(conversationSession(true));
    stand.serve((url) => {
      if (url.pathname === page.path) return Response.json(page.read({ body: { format: 'html', content: HTML }, interaction: 'share' }));
      if (url.pathname === sharePath) return Response.json(group);
      return url.pathname === `${sharePath}/document` ? Response.json({ ...group, documentState: 'ready' }) : undefined;
    });

    // When the transcript draws the call and prepares the shared document.
    const uploaded = stand.request(`${sharePath}/document`);
    mount(<ShownPage part={part} />);
    await uploaded;

    // Then the document carries the retained image, and neither a grant nor a file was read for it.
    const sent = stand.requests.find((request) => request.path === `${sharePath}/document`);
    expect(plotOf(z.object({ html: z.string() }).parse(JSON.parse(sent?.body ?? '')).html)).toBe(PLOT_DATA_URL);
    expect(reads(page.path)).toEqual([page.path]);
  });

  for (const { status, digit } of [{ status: 'completed', digit: '6' }, { status: 'error', digit: '7' }] as const) {
    test(`reports a ${status} call that names no retained page, and reads nothing for it`, async () => {
      // Given a bot conversation whose call ended whole, with no capture on it and none in its result.
      const page = retainedCase(digit);
      const call = page.call({ html: HTML });
      const part: ToolPart = { ...call, state: status === 'completed'
        ? { status, input: call.state.input, metadata: { openchamber: { ok: true } }, time: { start: 1, end: 2 },
          output: JSON.stringify({ schemaVersion: 1, ok: true, action: 'render.page', data: { title: 'Latency' } }) }
        : { status, input: { ...call.state.input, awaitAnswer: true }, error: 'Interrupted', time: { start: 1, end: 2 } } };
      app.openSession(conversationSession(true));
      stand.serve(() => undefined);

      // When the transcript draws the call.
      const view = mount(<ShownPage part={part} />);

      // Then it reports the page as unavailable, offers no retry that could change that, and draws and reads nothing.
      const failure = await failureNotice(view.host);
      expect(failure.querySelector('button')).toBeNull();
      expect(drawn(view.host)).toEqual([]);
      expect(reads(page.path)).toEqual([]);
    });
  }
});

describe('a page outside a bot', () => {
  test('keeps reading its images live and asks no owner for a snapshot', async () => {
    // Given an ordinary session whose render result happens to carry a reference.
    const page = retainedCase('d');
    app.openSession(conversationSession(false));
    stand.serve(() => undefined);

    // When the transcript draws the call.
    const grant = stand.request(GRANT_PATH);
    mount(<ShownPage part={page.call({ html: HTML })} />);

    // Then the live image read starts and the owner is never asked.
    expect(await grant).toBe(GRANT_PATH);
    expect(stand.paths()).not.toContain(page.path);
  });
});
