import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createGlobalMessageStreamHub } from './global-hub.js';
import { createMessageStreamWsRuntime } from './runtime.js';

const makeSocket = () => Object.assign(new EventEmitter(), {
  readyState: 1,
  frames: [],
  send(frame) { this.frames.push(JSON.parse(frame)); },
  ping() {},
  close() { this.readyState = 3; this.emit('close'); },
});

describe('merged front-door transport', () => {
  it.each([true, 7, 'opaque', ['part']].map((payload) => ({ payload })))(
    'preserves opaque upstream JSON $payload', async ({ payload }) => {
      // Given a native upstream whose payload is not an event object.
      const received = Promise.withResolvers();
      const hub = createGlobalMessageStreamHub({
        buildOpenCodeUrl: (route) => `http://upstream.test${route}`,
        getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
            signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
          },
        })),
      });
      hub.subscribeEvent((event) => { received.resolve(event.payload); });
      try {
        // When the upstream reaches the hub's provenance boundary.
        hub.start();
        // Then JSON arrays and primitives retain their wire value.
        expect(await received.promise).toEqual(payload);
      } finally { hub.stop(); }
    },
  );

  it('filters directory live and replay frames through the shared hub after reconnect', async () => {
    // Given two directory clients sharing the authenticated front-door hub.
    const firstConnection = Promise.withResolvers();
    const secondConnection = Promise.withResolvers();
    let connections = 0;
    let closeUpstream;
    const fetchImpl = vi.fn(async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        closeUpstream = () => controller.close();
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    })));
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (route) => `http://upstream.test${route}`,
      getOpenCodeAuthHeaders: () => ({}), fetchImpl, upstreamReconnectDelayMs: 0,
    });
    hub.subscribeStatus((status) => {
      if (status.type !== 'connect') return;
      (++connections === 1 ? firstConnection : secondConnection).resolve();
    });
    const bypass = vi.fn(async () => { throw new Error('directory reader bypassed the hub'); });
    const runtime = createMessageStreamWsRuntime({
      server: new EventEmitter(), frontDoor: true, globalEventHub: hub, wsClients: new Set(),
      isRequestOriginAllowed: async () => true, rejectWebSocketUpgrade() {},
      buildOpenCodeUrl: (route) => `http://upstream.test${route}`,
      getOpenCodeAuthHeaders: () => ({}), processForwardedEventPayload() {}, fetchImpl: bypass,
    });
    const [first, other, resumed] = [makeSocket(), makeSocket(), makeSocket()];
    const connect = (socket, suffix = '') => runtime.wsServer.emit('connection', socket, {
      url: `/api/event/ws?directory=%2Fspaces%2Fspace-a%2Frepo${suffix}`,
    });
    try {
      connect(first);
      runtime.wsServer.emit('connection', other, { url: '/api/event/ws?directory=%2Fspaces%2Fspace-b%2Frepo' });
      await firstConnection.promise;
      hub.injectEvent({ payload: { type: 'first' }, directory: '/spaces/space-a/repo', spaceId: 'space-a' });
      const cursor = hub.cursor();
      hub.injectEvent({ payload: { type: 'other' }, directory: '/spaces/space-b/repo', spaceId: 'space-b' });
      hub.injectEvent({ payload: { type: 'last' }, directory: '/spaces/space-a/repo', spaceId: 'space-a' });

      // When a directory client resumes and the upstream stream reconnects.
      connect(resumed, `&lastEventId=${encodeURIComponent(cursor)}`);
      const replayed = [...resumed.frames];
      closeUpstream();
      await secondConnection.promise;

      // Then both delivery paths keep directory filtering and directory readiness.
      expect(first.frames.filter((frame) => frame.type === 'event').map((frame) => frame.payload.type)).toEqual(['first', 'last']);
      expect(other.frames.filter((frame) => frame.type === 'event').map((frame) => frame.payload.type)).toEqual(['other']);
      expect(replayed).toMatchObject([{ type: 'ready', scope: 'directory', replayed: true }, { type: 'event', payload: { type: 'last' }, origin: 'space', spaceId: 'space-a' }]);
      expect(resumed.frames.at(-1)).toMatchObject({ type: 'ready', scope: 'directory' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(bypass).not.toHaveBeenCalled();
    } finally {
      first.close(); other.close(); resumed.close(); hub.stop(); await runtime.close();
    }
  });
});
