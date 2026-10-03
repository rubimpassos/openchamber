import { expect, test } from 'bun:test';
import { OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import type { GuestMessage, HostMessage } from './contract.ts';
import { connectHost, type HostFrame } from './host.ts';
import type { LoopbackEventSource, LoopbackWatchRuntime } from './loopback-watch.ts';

export class Stream implements LoopbackEventSource {
  onopen: LoopbackEventSource['onopen'] = null;
  onmessage: LoopbackEventSource['onmessage'] = null;
  onerror: LoopbackEventSource['onerror'] = null;
  closed = false;
  constructor(readonly url: string, readonly init: EventSourceInit) {}
  close = (): void => { this.closed = true; };
  open(): void { this.onopen?.(new Event('open')); }
  data(text: string): void { this.onmessage?.(new MessageEvent('message', { data: text })); }
  fail(): void { this.onerror?.(new Event('error')); }
}

export const createLoopbackFixture = () => {
  const events = new EventTarget();
  const posted: GuestMessage[] = [];
  const target: HostFrame = {
    parent: { postMessage: (message) => { posted.push(message); } },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  const streams: Stream[] = [];
  const timers = new Set<{ readonly callback: () => void; readonly delay: number }>();
  const resumes = new Set<() => void>();
  const environment = { paused: false, random: 0.5 };
  const runtime: LoopbackWatchRuntime = {
    createSource: (url, init) => {
      const source = new Stream(url, init);
      streams.push(source);
      return source;
    },
    schedule: (callback, delay) => {
      const timer = { callback, delay };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    random: () => environment.random,
    isPaused: () => environment.paused,
    onResume: (callback) => {
      resumes.add(callback);
      return () => { resumes.delete(callback); };
    },
  };
  const host = connectHost({ target, acceptSource: () => true, loopbackWatch: runtime });
  return {
    host, posted, streams, timers, resumes, environment, runtime,
    send: (message: HostMessage) => events.dispatchEvent(new MessageEvent('message', { data: message })),
    nextTimer: () => {
      const timer = timers.values().next().value;
      if (!timer) throw new Error('Expected a scheduled reconnect');
      timers.delete(timer);
      timer.callback();
      return timer.delay;
    },
    latestCall: () => {
      const call = posted.at(-1);
      if (!call || (call.type !== 'loopback-url' && call.type !== 'loopback-request')) throw new Error('Expected a loopback call');
      return call;
    },
    latestStream: () => {
      const stream = streams.at(-1);
      if (!stream) throw new Error('Expected a stream');
      return stream;
    },
  };
};

export const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
export const answerUrl = async (fixture: ReturnType<typeof createLoopbackFixture>, token = 'first'): Promise<void> => {
  fixture.send({ channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: fixture.latestCall().id, ok: true,
    payload: { url: `https://host.test/api/guests/demo/loopback/events?oc_url_token=${token}`, expiresAt: 123_456 } });
  await settle();
};

test('test transport delivers events and cancels timers when disposed', () => {
  // Given the narrow transport fake used to drive browser lifecycle events.
  const fixture = createLoopbackFixture();
  const source = fixture.runtime.createSource('https://host.test/', { withCredentials: false });
  const messages: string[] = [];
  source.onmessage = (event) => messages.push(event.data);
  const cancel = fixture.runtime.schedule(() => messages.push('timer'), 1000);
  try {
    // When a server message arrives and the pending timer is cancelled.
    fixture.latestStream().data('snapshot');
    cancel();
    // Then delivery is raw text and no timer remains to fire.
    expect(messages).toEqual(['snapshot']);
    expect(fixture.timers.size).toBe(0);
  } finally { fixture.host.dispose(); }
});
