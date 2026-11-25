import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';

import { SURFACE_AUDIO_PATH, SURFACE_FRAME_PATH, SURFACE_INPUT_PATH, SURFACE_CONTROL_PATH, SURFACE_RESIZE_PATH, SURFACE_CLIPBOARD_PATH } from '@openchamber/sdk';
import WebSocket from 'ws';

import { GuestServiceError } from './service.js';
import { createGuestSurfaceRuntime, isSurfaceGuest } from './surface.js';

const surfaceGuest = (overrides = {}) => ({
  id: 'sim',
  name: 'Simulator',
  packageRoot: '/ext/sim',
  enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', surface: true },
  capabilityGrants: ['service'],
  panel: { id: 'sim', name: 'Simulator', icon: 'window' },
  ...overrides,
});

/**
 * A service that never spawns: frames are pushed by the test, every other
 * call is recorded. The frame request waits like a real service would.
 */
const createFakeService = () => {
  const calls = [];
  const frames = [];
  const waiters = [];
  const frameRequests = [];
  let failWith = null;
  /** Test hook: a promise the input handler awaits before answering. */
  let inputGate = null;
  const pushFrame = (frame) => {
    frames.push(frame);
    for (const wake of waiters.splice(0)) wake();
  };
  const nextFrameAfter = (seq) => frames.find((frame) => frame.seq > seq) ?? null;
  const sounds = [];
  const soundWaiters = [];
  const audioRequests = [];
  // Test hook: what GET /surface/audio answers with no batch: 204, or 404 for a service without sound.
  let silentStatus = 204;
  const pushSound = (sound) => {
    sounds.push(sound);
    for (const wake of soundWaiters.splice(0)) wake();
  };
  const completed = [];
  let inputStatus = 204;
  const openServiceRequest = async ({ path, method, body, query, headers, signal }) => {
    calls.push({ path, method, body: body ? JSON.parse(body) : undefined, query, headers });
    if (path === SURFACE_FRAME_PATH) {
      for (const request of frameRequests.filter((request) => request.after === query.after)) request.resolve();
    }
    if (path === SURFACE_AUDIO_PATH) {
      for (const request of audioRequests.filter((request) => request.after === query.after)) request.resolve();
    }
    if (failWith) throw failWith;
    if (path === SURFACE_INPUT_PATH && inputGate) {
      const gate = inputGate;
      inputGate = null;
      await gate;
    }
    if (path === SURFACE_INPUT_PATH) completed.push(JSON.parse(body).events[0]);
    let response;
    if (path === SURFACE_FRAME_PATH) {
      const after = Number(query.after);
      let frame = nextFrameAfter(after);
      if (!frame) {
        await new Promise((resolve) => {
          const wake = () => resolve();
          waiters.push(wake);
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        frame = nextFrameAfter(after);
      }
      if (signal?.aborted) throw new GuestServiceError('cancelled', 'CANCELLED');
      response = frame
        ? new Response(frame.bytes, {
          status: 200,
          headers: {
            'content-type': frame.mime ?? 'image/png',
            'x-surface-seq': String(frame.serviceSeq ?? frame.seq),
            'x-surface-width': String(frame.width ?? 320),
            'x-surface-height': String(frame.height ?? 200),
            ...(frame.title ? { 'x-surface-title': frame.title } : {}),
            ...(frame.agentActive ? { 'x-surface-agent-active': '1' } : {}),
          },
        })
        : new Response(null, { status: 204 });
      if (frame?.viewId !== undefined) response.headers.set('x-surface-view-id', frame.viewId);
    } else if (path === SURFACE_AUDIO_PATH) {
      const after = Number(query.after);
      let sound = sounds.find((entry) => entry.seq > after) ?? null;
      if (!sound && silentStatus === 204) {
        await new Promise((resolve) => {
          soundWaiters.push(resolve);
          signal?.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 300);
        });
        sound = sounds.find((entry) => entry.seq > after) ?? null;
      }
      if (signal?.aborted) throw new GuestServiceError('cancelled', 'CANCELLED');
      response = sound
        ? new Response(sound.bytes, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'x-surface-seq': String(sound.seq),
            'x-surface-audio-codec': 'opus',
            'x-surface-audio-sample-rate': '48000',
            'x-surface-audio-channels': '2',
          },
        })
        : new Response(null, { status: silentStatus });
    } else if (path === SURFACE_RESIZE_PATH) {
      response = Response.json({ width: 640, height: 400 });
    } else if (path === SURFACE_CLIPBOARD_PATH) {
      response = Response.json({ text: 'copied inside' });
    } else if (path === SURFACE_INPUT_PATH) {
      response = new Response(null, { status: inputStatus });
    } else {
      response = new Response(null, { status: 204 });
    }
    return { response, finished: () => undefined };
  };
  return {
    calls,
    completed,
    pushFrame,
    pushSound,
    answerSilenceWith: (status) => { silentStatus = status; },
    frameRequestedAfter: (seq) => {
      const after = String(seq);
      if (calls.some((call) => call.path === SURFACE_FRAME_PATH && call.query.after === after)) return Promise.resolve();
      return new Promise((resolve) => frameRequests.push({ after, resolve }));
    },
    audioRequestedAfter: (seq) => {
      const after = String(seq);
      if (calls.some((call) => call.path === SURFACE_AUDIO_PATH && call.query.after === after)) return Promise.resolve();
      return new Promise((resolve) => audioRequests.push({ after, resolve }));
    },
    gateNextInput: (promise) => { inputGate = promise; },
    answerInputWith: (status) => { inputStatus = status; },
    fail: (error) => { failWith = error; for (const wake of waiters.splice(0)) wake(); },
    openServiceRequest,
    callsTo: (path) => calls.filter((call) => call.path === path),
  };
};

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const openViewer = (port, guestId = 'sim', query = '') => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/guests/${guestId}/surface/ws${query}`);
  ws.binaryType = 'arraybuffer';
  const inbox = [];
  const waiting = [];
  ws.on('message', (data, isBinary) => {
    // Bun's `ws` hands text frames over as a Uint8Array, not a Buffer.
    const item = isBinary ? { binary: Buffer.from(data) } : JSON.parse(Buffer.from(data).toString('utf8'));
    const waiter = waiting.shift();
    if (waiter) waiter(item);
    else inbox.push(item);
  });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiting.push(r)));
  const send = (message) => ws.send(JSON.stringify(message));
  // The pong follows the server's message handlers for all preceding frames.
  const received = () => new Promise((resolve) => { ws.once('pong', resolve); ws.ping(); });
  ws.on('open', () => resolve({ ws, next, send, received, pending: () => [...inbox], closed: new Promise((r) => ws.on('close', r)) }));
  ws.on('error', reject);
  ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade ${res.statusCode}`)));
});

const drainViewer = async (runtime, viewer) => {
  await viewer.received();
  await runtime.sessionOf('sim').queue;
};

const closeViewer = async (runtime, viewer, id = 'viewer-1') => {
  const session = runtime.sessionOf('sim');
  const closed = new Promise((resolve) => session.viewers.get(id).ws.once('close', resolve));
  viewer.ws.close();
  await Promise.all([viewer.closed, closed]);
  return session;
};

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const createHarness = async ({ guest = surfaceGuest(), rejectUpgradeAuth = false, setTimer } = {}) => {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const service = createFakeService();
  const holds = [];
  const rejected = [];
  const runtime = createGuestSurfaceRuntime({
    server,
    uiAuthController: rejectUpgradeAuth ? { enabled: true, ensureSessionToken: async () => null } : null,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade: (socket, status, message) => {
      rejected.push({ status, message });
      socket.end(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
    },
    persistPath: '/data/extensions.json',
    findGuest: async (id) => (guest && guest.id === id ? guest : null),
    idleStopMs: 60_000,
    openServiceRequest: service.openServiceRequest,
    holdService: (guestId) => {
      const entry = { guestId, released: false };
      holds.push(entry);
      return () => { entry.released = true; };
    },
    createViewerId: (() => { let n = 0; return () => `viewer-${++n}`; })(),
    ...(setTimer ? { setTimer } : {}),
  });
  const port = await listen(server);
  cleanups.push(async () => {
    runtime.stop();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port, runtime, service, holds, rejected };
};

describe('isSurfaceGuest', () => {
  test('needs enabled, approved, and a declared surface', () => {
    expect(isSurfaceGuest(surfaceGuest())).toBe(true);
    expect(isSurfaceGuest(surfaceGuest({ enabled: false }))).toBe(false);
    expect(isSurfaceGuest(surfaceGuest({ capabilityGrants: [] }))).toBe(false);
    expect(isSurfaceGuest(surfaceGuest({ service: { entry: 'service/main.js', runtime: 'host' } }))).toBe(false);
  });
});

describe('guest surface runtime', () => {
  test('refuses an upgrade for an unknown or surface-less extension', async () => {
    const { port, rejected } = await createHarness({ guest: surfaceGuest({ service: { entry: 'service/main.js', runtime: 'host' } }) });
    await expect(openViewer(port)).rejects.toThrow('upgrade 404');
    expect(rejected[0]).toMatchObject({ status: 404 });
  });

  test('refuses an upgrade without a UI session', async () => {
    const { port, rejected } = await createHarness({ rejectUpgradeAuth: true });
    await expect(openViewer(port)).rejects.toThrow('upgrade 401');
    expect(rejected[0]).toMatchObject({ status: 401 });
  });

  test('delivers frames one at a time per viewer and skips to the newest after an ack', async () => {
    const { port, service, holds, runtime } = await createHarness();
    const viewer = await openViewer(port);
    expect(await viewer.next()).toEqual({ type: 'hello', viewerId: 'viewer-1' });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'none', mine: false });
    expect(holds).toEqual([{ guestId: 'sim', released: false }]);

    service.pushFrame({ seq: 1, bytes: Buffer.from('frame-1'), title: 'Home' });
    const meta = await viewer.next();
    expect(meta).toEqual({ type: 'frame', seq: 1, width: 320, height: 200, mime: 'image/png', bytes: 7, agentActive: false, title: 'Home' });
    expect((await viewer.next()).binary.toString()).toBe('frame-1');

    // Two more frames arrive before the viewer acknowledges: it gets only the newest.
    service.pushFrame({ seq: 2, bytes: Buffer.from('frame-2') });
    await service.frameRequestedAfter(2);
    service.pushFrame({ seq: 3, bytes: Buffer.from('frame-3') });
    await service.frameRequestedAfter(3);
    viewer.send({ type: 'ack', seq: 1 });
    expect(await viewer.next()).toMatchObject({ type: 'frame', seq: 3 });
    expect((await viewer.next()).binary.toString()).toBe('frame-3');

    const session = await closeViewer(runtime, viewer);
    await session.queue;
    expect(holds[0].released).toBe(true);
    expect(service.callsTo(SURFACE_FRAME_PATH)[0].query).toEqual({ after: '0', wait: '25000' });
  });

  test('a viewer that asks for a window gets that many frames unacknowledged; an ack covers earlier ones', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port, 'sim', '?frames=2');
    await viewer.next();
    await viewer.next();
    const nextFrame = async () => {
      const meta = await viewer.next();
      await viewer.next();
      return meta.seq;
    };

    service.pushFrame({ seq: 1, bytes: Buffer.from('frame-1') });
    expect(await nextFrame()).toBe(1);
    service.pushFrame({ seq: 2, bytes: Buffer.from('frame-2') });
    expect(await nextFrame()).toBe(2);
    // Two in flight: the third waits for an ack.
    service.pushFrame({ seq: 3, bytes: Buffer.from('frame-3') });
    await service.frameRequestedAfter(3);
    service.pushFrame({ seq: 4, bytes: Buffer.from('frame-4') });
    await service.frameRequestedAfter(4);
    // Acknowledging 2 acknowledges the skipped 1 too: both slots open, and the newest is sent.
    viewer.send({ type: 'ack', seq: 2 });
    expect(await nextFrame()).toBe(4);
    // An ack for a frame no longer in flight changes nothing.
    viewer.send({ type: 'ack', seq: 1 });

    const click = { type: 'pointer', action: 'down', x: 1, y: 1, button: 0, buttons: 1, modifiers: { alt: false, ctrl: false, meta: false, shift: false } };
    viewer.send({ type: 'input', events: [click] });
    await viewer.next();
    await drainViewer(runtime, viewer);
    // Input is stamped with the frame the viewer last drew, not the one still in flight.
    expect(service.callsTo(SURFACE_INPUT_PATH)[0].headers['x-surface-frame-seq']).toBe('2');
  });

  test('confirms only successful explicit presentation using the sent frame identity and service sequence', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port, 'sim', '?frames=2');
    await viewer.next();
    await viewer.next();
    service.pushFrame({ seq: 7, bytes: Buffer.from('A'), viewId: 'view-A' });
    expect(await viewer.next()).toMatchObject({ seq: 7, viewId: 'view-A' });
    await viewer.next();

    // Legacy ACKs still advance the service cursor, without an unknown message to old clients.
    viewer.send({ type: 'ack', seq: 7 });
    await viewer.received();
    expect(viewer.pending()).toEqual([]);
    expect(runtime.viewerHeaders('sim', 'viewer-1')['x-surface-frame-seq']).toBe('7');

    service.pushFrame({ seq: 8, serviceSeq: 2, bytes: Buffer.from('B'), viewId: 'view-B' });
    expect(await viewer.next()).toMatchObject({ seq: 8, viewId: 'view-B' });
    await viewer.next();
    service.pushFrame({ seq: 9, serviceSeq: 3, bytes: Buffer.from('C'), viewId: 'view-C' });
    await viewer.next();
    await viewer.next();
    service.pushFrame({ seq: 10, serviceSeq: 4, bytes: Buffer.from('D'), viewId: 'view-D' });
    await service.frameRequestedAfter(10);

    // A failed draw frees both cumulative slots, while the last shown picture stays A.
    viewer.send({ type: 'ack', seq: 9, presented: false });
    expect(await viewer.next()).toMatchObject({ type: 'frame', seq: 10, viewId: 'view-D' });
    await viewer.next();
    await viewer.received();
    expect(viewer.pending()).toEqual([]);
    expect(runtime.viewerHeaders('sim', 'viewer-1')['x-surface-frame-seq']).toBe('7');

    viewer.send({ type: 'ack', seq: 10, presented: true, viewId: 'forged-by-viewer' });
    await viewer.received();
    expect(viewer.pending()).toEqual([{ type: 'presented', seq: 10, viewId: 'view-D' }]);
    expect(runtime.viewerHeaders('sim', 'viewer-1')['x-surface-frame-seq']).toBe('4');
    await viewer.next();
    viewer.send({ type: 'ack', seq: 8, presented: true });
    await viewer.received();
    expect(viewer.pending()).toEqual([]);
    expect(runtime.viewerHeaders('sim', 'viewer-1')['x-surface-frame-seq']).toBe('4');
  });

  test('an explicit successful ACK still releases a generic surface without view identity', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next();
    await viewer.next();
    service.pushFrame({ seq: 1, bytes: Buffer.from('generic') });
    await viewer.next();
    await viewer.next();
    service.pushFrame({ seq: 2, bytes: Buffer.from('next') });
    await service.frameRequestedAfter(2);
    viewer.send({ type: 'ack', seq: 1, presented: true });
    expect(await viewer.next()).toMatchObject({ type: 'frame', seq: 2 });
    await viewer.next();
    await viewer.received();
    expect(viewer.pending()).toEqual([]);
    expect(runtime.viewerHeaders('sim', 'viewer-1')['x-surface-frame-seq']).toBe('1');
  });

  test('asks the service for sound only while a viewer listens and gives it only to listeners', async () => {
    // Given two viewers, one of which turns sound on.
    const { port, service } = await createHarness();
    const listener = await openViewer(port);
    const other = await openViewer(port);
    for (const viewer of [listener, other]) {
      await viewer.next();
      await viewer.next();
    }
    expect(service.callsTo(SURFACE_AUDIO_PATH)).toHaveLength(0);
    listener.send({ type: 'audio', enabled: true });
    await listener.received();

    // When the service has a batch, then the listener gets its format and the packets, and the other viewer nothing.
    const packets = Buffer.from([0, 2, 7, 8, 0, 1, 9]);
    service.pushSound({ seq: 5, bytes: packets });
    expect(await listener.next()).toEqual({ type: 'audio', seq: 5, codec: 'opus', sampleRate: 48000, channels: 2, bytes: 7 });
    expect((await listener.next()).binary).toEqual(packets);
    expect(service.callsTo(SURFACE_AUDIO_PATH)[0].query).toEqual({ after: '0', wait: '25000' });

    // When the listener turns sound off, then the host stops asking.
    listener.send({ type: 'audio', enabled: false });
    await listener.received();
    const asked = service.callsTo(SURFACE_AUDIO_PATH).length;
    service.pushSound({ seq: 6, bytes: packets });

    // Then the viewer without sound was sent nothing at all meanwhile.
    service.pushFrame({ seq: 1, bytes: Buffer.from('frame-1') });
    expect(await other.next()).toMatchObject({ type: 'frame', seq: 1 });
    expect(service.callsTo(SURFACE_AUDIO_PATH)).toHaveLength(asked);
  });

  test('tells listeners when the extension has no sound, and a broken batch never reaches them', async () => {
    const { port, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next();
    await viewer.next();

    // When a service without sound answers 404, then the listener is told once and the session goes on.
    service.answerSilenceWith(404);
    viewer.send({ type: 'audio', enabled: true });
    expect(await viewer.next()).toEqual({ type: 'audio-state', available: false });
    service.pushFrame({ seq: 1, bytes: Buffer.from('frame-1') });
    expect(await viewer.next()).toMatchObject({ type: 'frame', seq: 1 });
  });

  test('says when sound comes back after a failure, and a broken batch never reaches a listener', async () => {
    // Given a host whose wait before asking a failing service again is immediate.
    const retries = [];
    const setTimer = (callback, ms) => {
      if (ms === 30_000) retries.push(ms);
      return setTimeout(callback, ms === 30_000 ? 0 : ms);
    };
    const { port, service } = await createHarness({ setTimer });
    const viewer = await openViewer(port);
    await viewer.next();
    await viewer.next();

    // When the service first answers with packets whose lengths do not add up.
    service.pushSound({ seq: 1, bytes: Buffer.from([0, 9, 1]) });
    viewer.send({ type: 'audio', enabled: true });

    // Then the listener is told there is no sound, and gets no part of that batch.
    expect(await viewer.next()).toEqual({ type: 'audio-state', available: false });

    // When the service then has a good batch, then the listener is told the sound is back, and gets it.
    const packets = Buffer.from([0, 2, 7, 8]);
    service.pushSound({ seq: 2, bytes: packets });
    expect(await viewer.next()).toEqual({ type: 'audio-state', available: true });
    expect(await viewer.next()).toEqual({ type: 'audio', seq: 2, codec: 'opus', sampleRate: 48000, channels: 2, bytes: 4 });
    expect((await viewer.next()).binary).toEqual(packets);
    expect(retries.length).toBeGreaterThan(0);
  });

  test('sends no more sound to a listener that stopped reading until it catches up', async () => {
    // Given a listener whose socket reports a controllable write backlog.
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next();
    await viewer.next();
    let backlog = 0;
    const socket = runtime.sessionOf('sim').viewers.get('viewer-1').ws;
    Object.defineProperty(socket, 'bufferedAmount', { get: () => backlog });
    viewer.send({ type: 'audio', enabled: true });
    const packets = Buffer.from([0, 2, 7, 8]);
    service.pushSound({ seq: 1, bytes: packets });
    expect(await viewer.next()).toMatchObject({ type: 'audio', seq: 1 });
    await viewer.next();

    // When one batch arrives above the send budget and another after recovery.
    backlog = 1_000_001;
    service.pushSound({ seq: 2, bytes: packets });
    await service.audioRequestedAfter(2);
    backlog = 0;
    service.pushSound({ seq: 3, bytes: packets });

    // Then only the new batch arrives; the skipped sound was never queued.
    expect(await viewer.next()).toMatchObject({ type: 'audio', seq: 3 });
    expect((await viewer.next()).binary).toEqual(packets);
  });

  test('the first input takes control, is forwarded, and tells the service; release hands it back', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next();
    await viewer.next();

    const click = { type: 'pointer', action: 'down', x: 10, y: 20, button: 0, buttons: 1, modifiers: { alt: false, ctrl: false, meta: false, shift: false } };
    viewer.send({ type: 'input', events: [click] });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    await drainViewer(runtime, viewer);
    expect(runtime.userControls('sim')).toBe(true);
    expect(service.callsTo(SURFACE_INPUT_PATH)[0].body).toEqual({ events: [click] });
    expect(service.callsTo(SURFACE_CONTROL_PATH).map((call) => call.body)).toEqual([{ controller: 'user', viewer: 'viewer-1' }]);

    viewer.send({ type: 'release' });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'none', mine: false });
    await drainViewer(runtime, viewer);
    expect(runtime.userControls('sim')).toBe(false);
    expect(service.callsTo(SURFACE_CONTROL_PATH).map((call) => call.body)).toEqual([{ controller: 'user', viewer: 'viewer-1' }, { controller: 'none' }]);
  });

  test('a second viewer cannot take control from the first and is told who has it', async () => {
    const { port, service, runtime } = await createHarness();
    const first = await openViewer(port);
    await first.next(); await first.next();
    const second = await openViewer(port);
    await second.next(); await second.next();

    const key = { type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: { alt: false, ctrl: false, meta: false, shift: false } };
    first.send({ type: 'input', events: [key] });
    expect(await first.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    expect(await second.next()).toEqual({ type: 'control', controller: 'user', mine: false });

    second.send({ type: 'input', events: [key] });
    expect(await second.next()).toEqual({ type: 'control', controller: 'user', mine: false });
    await drainViewer(runtime, second);
    expect(service.callsTo(SURFACE_INPUT_PATH)).toHaveLength(1);

    // The holder disconnecting releases control for everyone.
    first.ws.close();
    expect(await second.next()).toEqual({ type: 'control', controller: 'none', mine: false });
  });

  test('agent activity holds control until the hold expires, and the user always wins', async () => {
    const { port, runtime, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();

    // Not attached to a session: nothing to note, nothing thrown.
    runtime.noteAgentActivity('other');

    runtime.noteAgentActivity('sim');
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'agent', mine: false });
    expect(runtime.userControls('sim')).toBe(false);
    // A second action while already agent-held does not re-broadcast.
    runtime.noteAgentActivity('sim');

    const text = { type: 'text', text: 'hello' };
    viewer.send({ type: 'input', events: [text] });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    await drainViewer(runtime, viewer);
    expect(service.callsTo(SURFACE_INPUT_PATH)[0].body).toEqual({ events: [text] });
  });

  test('the agent hold expires back to nobody', async () => {
    const timers = [];
    const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    const service = createFakeService();
    const runtime = createGuestSurfaceRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: (socket) => socket.destroy(),
      persistPath: '/data/extensions.json',
      findGuest: async () => surfaceGuest(),
      idleStopMs: 60_000,
      openServiceRequest: service.openServiceRequest,
      holdService: () => () => undefined,
      setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimer: () => undefined,
    });
    const port = await listen(server);
    cleanups.push(async () => { runtime.stop(); await new Promise((resolve) => server.close(resolve)); });
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    runtime.noteAgentActivity('sim');
    expect(await viewer.next()).toMatchObject({ type: 'control', controller: 'agent' });
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'none', mine: false });
  });

  test('hovering over the picture does not take control; a click does', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    viewer.send({ type: 'input', events: [{ type: 'pointer', action: 'move', x: 5, y: 5, button: -1, buttons: 0, modifiers }] });
    await drainViewer(runtime, viewer);
    expect(runtime.userControls('sim')).toBe(false);
    expect(service.callsTo(SURFACE_INPUT_PATH)).toHaveLength(0);

    runtime.noteAgentActivity('sim');
    expect(await viewer.next()).toMatchObject({ type: 'control', controller: 'agent' });
    viewer.send({ type: 'input', events: [{ type: 'pointer', action: 'move', x: 6, y: 6, button: -1, buttons: 0, modifiers }] });
    await drainViewer(runtime, viewer);
    expect(runtime.userControls('sim')).toBe(false);

    viewer.send({ type: 'input', events: [{ type: 'pointer', action: 'down', x: 6, y: 6, button: 0, buttons: 1, modifiers }] });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    // Now moves flow, as the holder's.
    viewer.send({ type: 'input', events: [{ type: 'pointer', action: 'move', x: 7, y: 7, button: -1, buttons: 0, modifiers }] });
    await drainViewer(runtime, viewer);
    expect(service.callsTo(SURFACE_INPUT_PATH)).toHaveLength(2);
  });

  test('a key event reaches the service with the keyCode the viewer browser reported', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const key = { type: 'key', action: 'down', key: '.', code: 'Period', keyCode: 190, modifiers: { alt: false, ctrl: false, meta: false, shift: false } };
    viewer.send({ type: 'input', events: [key] });
    await viewer.next(); // control
    await drainViewer(runtime, viewer);
    expect(service.callsTo(SURFACE_INPUT_PATH)[0].body).toEqual({ events: [key] });
  });

  test('input batches reach the service in socket order even when one is slow', async () => {
    const { port, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    let open;
    service.gateNextInput(new Promise((resolve) => { open = resolve; }));
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    await viewer.next(); // control
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'b', code: 'KeyB', modifiers }] });
    viewer.send({ type: 'clipboard-read', id: 'c1' });
    await viewer.received();
    expect(service.completed).toHaveLength(0);
    expect(service.callsTo(SURFACE_CLIPBOARD_PATH)).toHaveLength(0);
    open();
    expect(await viewer.next()).toEqual({ type: 'clipboard', id: 'c1', text: 'copied inside' });
    expect(service.completed.map((event) => event.key)).toEqual(['a', 'b']);
  });

  test('a session ended while the user held control never talks to the service again', async () => {
    const { port, service, runtime, holds } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    expect(await viewer.next()).toMatchObject({ type: 'control', controller: 'user', mine: true });
    await drainViewer(runtime, viewer);
    const callsBefore = service.calls.length;
    const session = runtime.sessionOf('sim');
    const serverClosed = new Promise((resolve) => session.viewers.get('viewer-1').ws.once('close', resolve));

    // Approval withdrawn: the guest routes end the session; the socket closes after.
    runtime.endForGuest('sim');
    expect(await viewer.next()).toEqual({ type: 'ended', reason: 'extension-unavailable' });
    await viewer.closed;
    await serverClosed;
    await session.queue;
    expect(service.calls.length).toBe(callsBefore);
    expect(holds[0].released).toBe(true);
  });

  test('the last viewer leaving while holding control tells the service it let go', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    await viewer.next();
    await drainViewer(runtime, viewer);
    const session = await closeViewer(runtime, viewer);
    await session.queue;
    expect(service.callsTo(SURFACE_CONTROL_PATH).map((call) => call.body)).toEqual([{ controller: 'user', viewer: 'viewer-1' }, { controller: 'none' }]);
  });

  test('a queued input from before a hand-back does not take control again', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    let open;
    service.gateNextInput(new Promise((resolve) => { open = resolve; }));
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    expect(await viewer.next()).toMatchObject({ type: 'control', controller: 'user', mine: true });
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'b', code: 'KeyB', modifiers }] });
    viewer.send({ type: 'release' });
    expect(await viewer.next()).toEqual({ type: 'control', controller: 'none', mine: false });
    expect(runtime.userControls('sim')).toBe(false);
    open();
    await drainViewer(runtime, viewer);
    expect(runtime.userControls('sim')).toBe(false);
    // B was typed before the release and still belonged to the holder: it is
    // not re-taken, and it is not delivered under nobody's control either.
    expect(service.completed.map((event) => event.key)).toEqual(['a']);
  });

  test('a queued input from a viewer that left never makes it the controller', async () => {
    const { port, service, runtime } = await createHarness();
    const first = await openViewer(port);
    await first.next(); await first.next();
    const second = await openViewer(port);
    await second.next(); await second.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    let open;
    service.gateNextInput(new Promise((resolve) => { open = resolve; }));
    first.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    await first.next();
    expect(await second.next()).toEqual({ type: 'control', controller: 'user', mine: false });
    first.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'b', code: 'KeyB', modifiers }] });
    const session = await closeViewer(runtime, first);
    expect(await second.next()).toEqual({ type: 'control', controller: 'none', mine: false });
    open();
    await session.queue;
    expect(runtime.userControls('sim')).toBe(false);
    second.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'c', code: 'KeyC', modifiers }] });
    expect(await second.next()).toEqual({ type: 'control', controller: 'user', mine: true });
    await drainViewer(runtime, second);
    expect(service.completed.map((event) => event.key)).toEqual(['a', 'c']);
  });

  test('a deactivation while the closed panel\'s farewell is still queued cancels it', async () => {
    const { port, service, runtime, holds } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    let open;
    service.gateNextInput(new Promise((resolve) => { open = resolve; }));
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers }] });
    await viewer.next();
    await viewer.received();
    const session = await closeViewer(runtime, viewer);
    // The session is still registered: its final "none" waits behind the slow input.
    expect(runtime.sessionOf('sim')).not.toBeNull();
    const callsBefore = service.calls.length;
    runtime.endForGuest('sim');
    open();
    await session.queue;
    expect(service.calls.length).toBe(callsBefore);
    expect(runtime.sessionOf('sim')).toBeNull();
    expect(holds[0].released).toBe(true);
  });

  test('resize and clipboard reads round-trip through the service; clipboard needs control', async () => {
    const { port, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    viewer.send({ type: 'resize', width: 800, height: 600 });
    expect(await viewer.next()).toEqual({ type: 'resized', width: 640, height: 400 });
    expect(service.callsTo(SURFACE_RESIZE_PATH)[0].body).toEqual({ width: 800, height: 600 });
    viewer.send({ type: 'clipboard-read', id: 'c0' });
    expect(await viewer.next()).toMatchObject({ type: 'error', code: 'NOT_CONTROLLING' });
    expect(service.callsTo(SURFACE_CLIPBOARD_PATH)).toHaveLength(0);
    const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
    viewer.send({ type: 'input', events: [{ type: 'key', action: 'down', key: 'c', code: 'KeyC', modifiers: { ...modifiers, meta: true } }] });
    await viewer.next();
    viewer.send({ type: 'clipboard-read', id: 'c1' });
    expect(await viewer.next()).toEqual({ type: 'clipboard', id: 'c1', text: 'copied inside' });
  });

  test('a malformed viewer message is answered with an error, not a drop', async () => {
    const { port } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    viewer.ws.send('{"type":"input","events":[{"type":"pointer"}]}');
    expect(await viewer.next()).toMatchObject({ type: 'error', code: 'BAD_MESSAGE' });
  });

  test('a service that stops ends the session for every viewer; deactivation does too', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); await viewer.next();
    service.fail(new GuestServiceError('gone', 'SERVICE_FAILED'));
    expect(await viewer.next()).toEqual({ type: 'ended', reason: 'service-stopped' });
    await viewer.closed;

    service.fail(null);
    const again = await openViewer(port);
    await again.next(); await again.next();
    runtime.endForGuest('sim');
    expect(await again.next()).toEqual({ type: 'ended', reason: 'extension-unavailable' });
    await again.closed;
    expect(runtime.sessionOf('sim')).toBeNull();
  });

  test('stamps input with the viewer and the service frame it last drew', async () => {
    const { port, service, runtime } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next(); // hello
    await viewer.next(); // control
    const click = { type: 'pointer', action: 'down', x: 1, y: 1, button: 0, buttons: 1, modifiers: { alt: false, ctrl: false, meta: false, shift: false } };

    // Nothing drawn yet: frame 0.
    viewer.send({ type: 'input', events: [click] });
    await drainViewer(runtime, viewer);
    expect(service.callsTo(SURFACE_INPUT_PATH)[0].headers).toEqual({ 'x-surface-viewer': 'viewer-1', 'x-surface-frame-seq': '0' });
    expect(service.callsTo(SURFACE_CONTROL_PATH).at(-1).body).toEqual({ controller: 'user', viewer: 'viewer-1' });
    await viewer.next(); // control: mine

    service.pushFrame({ seq: 7, bytes: Buffer.from('frame-7') });
    await viewer.next();
    await viewer.next();
    // Sent but not yet drawn: input still counts as made on the old picture.
    viewer.send({ type: 'input', events: [click] });
    viewer.send({ type: 'ack', seq: 7 });
    viewer.send({ type: 'input', events: [click] });
    await drainViewer(runtime, viewer);
    const stamped = service.callsTo(SURFACE_INPUT_PATH).map((call) => call.headers['x-surface-frame-seq']);
    expect(stamped).toEqual(['0', '0', '7']);

    expect(runtime.viewerHeaders('sim', 'viewer-1')).toEqual({ 'x-surface-viewer': 'viewer-1', 'x-surface-viewer-controls': '1', 'x-surface-frame-seq': '7' });
    expect(runtime.viewerHeaders('sim', 'viewer-2')).toBeNull();
    expect(runtime.viewerHeaders('other', 'viewer-1')).toBeNull();

    viewer.send({ type: 'release' });
    await drainViewer(runtime, viewer);
    expect(runtime.viewerHeaders('sim', 'viewer-1')['x-surface-viewer-controls']).toBe('0');
  });

  test('tells the viewer when the service refuses input made on an old picture', async () => {
    const { port, service } = await createHarness();
    const viewer = await openViewer(port);
    await viewer.next();
    await viewer.next();
    service.answerInputWith(409);
    viewer.send({ type: 'input', events: [{ type: 'text', text: 'hi' }] });
    await viewer.next(); // control: mine
    expect(await viewer.next()).toMatchObject({ type: 'error', code: 'INPUT_STALE' });
  });
});
