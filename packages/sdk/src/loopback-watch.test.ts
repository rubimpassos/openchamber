import { expect, spyOn, test } from 'bun:test';
import { OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { HostRequestError } from './host.ts';
import { watchLoopback, type LoopbackWatchEvent } from './loopback-watch.ts';
import { answerUrl, createLoopbackFixture, settle } from './loopback-fixture.test.ts';

test('delivers raw text and connection state when the stream becomes live', async () => {
  // Given one watch waiting for its parent-minted URL.
  const fixture = createLoopbackFixture();
  const seen: LoopbackWatchEvent[] = [];
  fixture.host.watchLoopback({ path: '/events' }, (event) => seen.push(event));
  try {
    await settle();
    await answerUrl(fixture);
    // When the server opens and sends data.
    fixture.latestStream().open();
    fixture.latestStream().data('{"raw":true}');
    // Then the helper does not parse application data or send cookies.
    expect(seen).toEqual([{ type: 'connection', state: 'connecting' }, { type: 'connection', state: 'live' }, { type: 'data', text: '{"raw":true}' }]);
    expect(fixture.latestStream().init).toEqual({ withCredentials: false });
    expect(fixture.timers.size).toBe(0);
  } finally { fixture.host.dispose(); }
});

test('mints a fresh URL with exactly one source when a stream fails', async () => {
  // Given a connected stream, whose token must never be reused for reconnect.
  const fixture = createLoopbackFixture();
  fixture.host.watchLoopback({ path: '/events' }, () => {});
  try {
    await settle();
    await answerUrl(fixture, 'first');
    const original = fixture.latestStream();
    const lateError = original.onerror;
    // When the source fails, then the custom retry runs.
    original.fail();
    lateError?.(new Event('error'));
    expect(original.closed).toBe(true);
    expect(fixture.timers.size).toBe(1);
    expect(fixture.nextTimer()).toBe(1000);
    await answerUrl(fixture, 'second');
    // Then the old source stays closed and only the fresh URL is active.
    expect(fixture.streams.filter((source) => !source.closed)).toHaveLength(1);
    expect(new URL(fixture.latestStream().url).searchParams.get('oc_url_token')).toBe('second');
    expect(fixture.posted.filter((message) => message.type === 'loopback-url')).toHaveLength(2);
  } finally { fixture.host.dispose(); }
});

test('ignores a stale URL when the watch is disposed during admission', async () => {
  // Given an unanswered URL request.
  const fixture = createLoopbackFixture();
  const seen: LoopbackWatchEvent[] = [];
  const stop = fixture.host.watchLoopback({ path: '/events' }, (event) => seen.push(event));
  try {
    await settle();
    // When disposal precedes the parent's answer.
    stop();
    await answerUrl(fixture);
    // Then no EventSource or retry survives, and no late listener call arrives.
    expect(fixture.streams).toHaveLength(0);
    expect(fixture.timers.size).toBe(0);
    expect(fixture.resumes.size).toBe(0);
    expect(seen).toEqual([{ type: 'connection', state: 'connecting' }]);
  } finally { fixture.host.dispose(); }
});

test('closes live streams when the host client is disposed', async () => {
  // Given a live watch owned by connectHost.
  const fixture = createLoopbackFixture();
  fixture.host.watchLoopback({ path: '/events' }, () => {});
  await settle();
  await answerUrl(fixture);
  // When the host client is disposed without an explicit watch disposer call.
  fixture.host.dispose();
  // Then source, browser listeners and retry timer are all retired.
  expect(fixture.latestStream().closed).toBe(true);
  expect(fixture.resumes.size).toBe(0);
  expect(fixture.timers.size).toBe(0);
});

test('cancels pending retries when the watch is disposed', async () => {
  // Given a source that failed and scheduled a retry.
  const fixture = createLoopbackFixture();
  const stop = fixture.host.watchLoopback({ path: '/events' }, () => {});
  try {
    await settle();
    await answerUrl(fixture);
    fixture.latestStream().fail();
    // When the watch ends before that retry.
    stop();
    // Then no queued reconnect can create a new source.
    expect(fixture.timers.size).toBe(0);
    expect(fixture.resumes.size).toBe(0);
  } finally { fixture.host.dispose(); }
});

test.each(['NOT_GRANTED', 'UNSUPPORTED'] as const)('terminates with a typed error when URL admission returns %s', async (code) => {
  // Given a watch waiting for permission or a supported direct transport.
  const fixture = createLoopbackFixture();
  const seen: LoopbackWatchEvent[] = [];
  fixture.host.watchLoopback({ path: '/events' }, (event) => seen.push(event));
  try {
    await settle();
    // When the host reports a permanent refusal.
    fixture.send({ channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: fixture.latestCall().id, ok: false, code, error: 'Refused' });
    await settle();
    // Then the application can fall back, with no retry resources retained.
    expect(seen.at(-1)).toMatchObject({ type: 'connection', state: 'unavailable', error: { code } });
    expect(fixture.timers.size).toBe(0);
    expect(fixture.resumes.size).toBe(0);
  } finally { fixture.host.dispose(); }
});

test('backs off exponentially when repeated handshakes fail before data', async () => {
  // Given consecutive connections that never deliver a healthy snapshot.
  const fixture = createLoopbackFixture();
  fixture.host.watchLoopback({ path: '/events' }, () => {});
  try {
    await settle();
    const delays: number[] = [];
    // When each connection immediately fails, followed by a healthy snapshot.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await answerUrl(fixture, String(attempt));
      fixture.latestStream().open();
      fixture.latestStream().fail();
      delays.push(fixture.nextTimer());
    }
    await answerUrl(fixture, 'healthy');
    fixture.latestStream().data('snapshot');
    fixture.latestStream().fail();
    delays.push(fixture.nextTimer());
    // Then retry costs grow to the cap, resetting only on real data.
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 1000]);
  } finally { fixture.host.dispose(); }
});

test.each([0, 1])('jitters reconnect delay when the random sample is %s', async (random) => {
  // Given a deterministic random source.
  const fixture = createLoopbackFixture();
  fixture.environment.random = random;
  fixture.host.watchLoopback({ path: '/events' }, () => {});
  try {
    await settle();
    await answerUrl(fixture);
    // When the stream fails.
    fixture.latestStream().fail();
    // Then retries spread across the bounded 20 percent jitter window.
    expect(fixture.nextTimer()).toBe(random === 0 ? 800 : 1200);
  } finally { fixture.host.dispose(); }
});

test('uses the cap and resumes promptly when the browser is hidden or offline', async () => {
  // Given a paused browser after a failed connection.
  const fixture = createLoopbackFixture();
  fixture.environment.paused = true;
  fixture.host.watchLoopback({ path: '/events' }, () => {});
  try {
    await settle();
    await answerUrl(fixture);
    fixture.latestStream().fail();
    expect([...fixture.timers].map((timer) => timer.delay)).toEqual([15000]);
    // When the browser becomes usable before the long retry expires.
    fixture.environment.paused = false;
    for (const resume of fixture.resumes) resume();
    // Then it cancels the timer and asks the parent for a fresh URL.
    expect(fixture.timers.size).toBe(0);
    expect(fixture.posted.filter((message) => message.type === 'loopback-url')).toHaveLength(2);
  } finally { fixture.host.dispose(); }
});

test('does not log tokens when EventSource construction throws a URL-bearing exception', async () => {
  // Given a browser error that embeds a scoped token.
  const fixture = createLoopbackFixture();
  const errorLog = spyOn(console, 'error');
  const warnLog = spyOn(console, 'warn');
  const log = spyOn(console, 'log');
  const seen: LoopbackWatchEvent[] = [];
  const lifetime = new AbortController();
  const stop = watchLoopback({ mint: async () => ({ url: 'https://host.test/?oc_url_token=private', expiresAt: 1 }), signal: lifetime.signal },
    (event) => seen.push(event), { ...fixture.runtime, createSource: () => { throw new TypeError('https://host.test/?oc_url_token=private'); } });
  try {
    // When the constructor fails.
    await settle();
    // Then transport diagnostics are typed, sanitized, and never logged.
    expect(seen.at(-1)).toMatchObject({ type: 'connection', state: 'unavailable', error: { code: 'HOST_REJECTED' } });
    expect(JSON.stringify(seen)).not.toContain('private');
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(seen.some((event) => event.type === 'connection' && event.error instanceof HostRequestError)).toBe(true);
  } finally { stop(); fixture.host.dispose(); errorLog.mockRestore(); warnLog.mockRestore(); log.mockRestore(); }
});
