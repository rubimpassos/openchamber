
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';
import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

import {
  SURFACE_AGENT_ACTIVE_HEADER,
  SURFACE_AGENT_HOLD_MS,
  SURFACE_AUDIO_CHANNELS_HEADER,
  SURFACE_AUDIO_CHANNELS_MAX,
  SURFACE_AUDIO_CODEC_HEADER,
  SURFACE_AUDIO_CODECS,
  SURFACE_AUDIO_MAX_BYTES,
  SURFACE_AUDIO_PATH,
  SURFACE_AUDIO_SAMPLE_RATE_HEADER,
  SURFACE_AUDIO_SAMPLE_RATE_MAX,
  SURFACE_AUDIO_SAMPLE_RATE_MIN,
  SURFACE_CLIPBOARD_PATH,
  SURFACE_CONTROL_PATH,
  SURFACE_FRAME_MAX_BYTES,
  SURFACE_FRAME_MIMES,
  SURFACE_FRAME_PATH,
  SURFACE_FRAME_SEQ_HEADER,
  SURFACE_FRAME_WAIT_MS,
  SURFACE_HEIGHT_HEADER,
  SURFACE_INPUT_PATH,
  SURFACE_RESIZE_PATH,
  SURFACE_SEQ_HEADER,
  SURFACE_TITLE_HEADER,
  SURFACE_TITLE_MAX,
  SURFACE_VIEWER_CONTROLS_HEADER,
  SURFACE_VIEWER_HEADER,
  SURFACE_WIDTH_HEADER,
  isGuestApproved,
  requestedGuestCapabilities,
} from '@openchamber/sdk';
import {
  surfaceClipboardAnswerSchema,
  surfaceResizeAnswerSchema,
  surfaceViewerMessageSchema,
} from '@openchamber/sdk/schemas';

import { GuestServiceError, holdGuestService, openGuestServiceRequest } from './service.js';
import type { GuestServiceRequest } from './service.js';
import type { GuestRecord } from './contracts.js';
import type { SurfaceHostMessage, SurfaceViewerMessage } from '@openchamber/sdk/schemas';
import type { RawData, WebSocket } from '../shared/websocket-contracts.js';
import type { SurfaceController, SurfaceEndReason, SurfaceFrame, SurfaceGuest, SurfaceRuntimeOptions, SurfaceSession, SurfaceViewer } from './surface-contracts.js';

const SURFACE_WS_PATH = /^\/api\/guests\/([a-z][a-z0-9-]*)\/surface\/ws$/;
const VIEWER_MESSAGE_MAX_BYTES = 256 * 1024;
const QUICK_REQUEST_TIMEOUT_MS = 10_000;
const FRAME_MIMES: ReadonlySet<string> = new Set(SURFACE_FRAME_MIMES);
const isFrameMime = (value: string): value is SurfaceFrame['mime'] => FRAME_MIMES.has(value);
const MAX_FRAMES_IN_FLIGHT = 3;

/** The viewer's `frames` query: how many unacknowledged frames it can take. Viewers that predate it get one. */
const readFramesInFlight = (searchParams: URLSearchParams) => {
  const value = Number(searchParams.get('frames'));
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_FRAMES_IN_FLIGHT) : 1;
};

export const isSurfaceGuest = (guest: GuestRecord | null | undefined): guest is SurfaceGuest => (
  !!guest
  && guest.enabled !== false
  && guest.service?.surface === true
  && isGuestApproved({
    requested: requestedGuestCapabilities(guest),
    granted: Array.isArray(guest.capabilityGrants) ? guest.capabilityGrants : [],
  })
);

const readDimension = (value: string | null) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

export const createGuestSurfaceRuntime = ({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  persistPath,
  findGuest,
  idleStopMs,
  openServiceRequest = openGuestServiceRequest,
  holdService = holdGuestService,
  createViewerId = () => `viewer-${randomUUID()}`,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: SurfaceRuntimeOptions) => {
  const sessions = new Map<string, SurfaceSession>();

  const send = (viewer: SurfaceViewer, message: SurfaceHostMessage) => {
    if (viewer.ws.readyState !== 1) return;
    try {
      viewer.ws.send(JSON.stringify(message));
    } catch {
      void 0;
    }
  };

  const controllerKind = (session: SurfaceSession) => (
    session.controller === 'none' || session.controller === 'agent' ? session.controller : 'user'
  );

  const serviceRequest = (session: SurfaceSession, params: Omit<GuestServiceRequest, 'guestId' | 'guestName' | 'packageRoot' | 'service' | 'granted' | 'persistPath' | 'idleStopMs'>) => openServiceRequest({
    guestId: session.guestId,
    guestName: session.guest.name,
    packageRoot: session.guest.packageRoot,
    service: session.guest.service,
    granted: session.guest.capabilityGrants,
    persistPath,
    idleStopMs,
    ...params,
  });

  const enqueue = (session: SurfaceSession, task: () => Promise<void>) => {
    const run = session.queue.then(async () => {
      if (session.ended) return;
      await task();
    }).catch(() => undefined);
    session.queue = run;
    return run;
  };

  const notifyService = async (session: SurfaceSession, controller: SurfaceController, viewerId: string | undefined) => {
    if (session.ended) return;
    try {
      const { response, finished } = await serviceRequest(session, {
        method: 'POST',
        path: SURFACE_CONTROL_PATH,
        body: JSON.stringify(controller === 'user' && viewerId ? { controller, viewer: viewerId } : { controller }),
        timeoutMs: QUICK_REQUEST_TIMEOUT_MS,
      });
      await response.arrayBuffer().catch(() => undefined);
      finished();
    } catch {
      void 0;
    }
  };

  const broadcastControl = (session: SurfaceSession) => {
    const kind = controllerKind(session);
    for (const viewer of session.viewers.values()) {
      send(viewer, { type: 'control', controller: kind, mine: session.controller === viewer.id });
    }
    const holder = kind === 'user' ? session.controller : undefined;
    void enqueue(session, () => notifyService(session, kind, holder));
  };

  const clearAgentTimer = (session: SurfaceSession) => {
    if (session.agentTimer) {
      clearTimer(session.agentTimer);
      session.agentTimer = null;
    }
  };

  const setController = (session: SurfaceSession, controller: string) => {
    if (session.controller === controller) return;
    session.controller = controller;
    clearAgentTimer(session);
    broadcastControl(session);
  };

  const deliverLatest = (session: SurfaceSession, viewer: SurfaceViewer) => {
    const frame = session.latest;
    if (!frame || viewer.inFlight.length >= viewer.framesInFlight || viewer.sentSeq >= frame.seq || viewer.ws.readyState !== 1) return;
    viewer.inFlight.push({ seq: frame.seq, serviceSeq: frame.serviceSeq });
    viewer.sentSeq = frame.seq;
    const meta: Extract<SurfaceHostMessage, { type: 'frame' }> = {
      type: 'frame',
      seq: frame.seq,
      width: frame.width,
      height: frame.height,
      mime: frame.mime,
      bytes: frame.bytes.length,
      agentActive: frame.agentActive,
    };
    if (frame.title) meta.title = frame.title;
    send(viewer, meta);
    try {
      viewer.ws.send(frame.bytes, { binary: true });
    } catch {
      void 0;
    }
  };

  const endSession = (session: SurfaceSession, reason: SurfaceEndReason) => {
    if (session.ended) return;
    session.ended = true;
    sessions.delete(session.guestId);
    clearAgentTimer(session);
    session.pumpAbort?.abort();
    session.pumpAbort = null;
    session.audioAbort?.abort();
    session.audioAbort = null;
    session.releaseHold?.();
    session.releaseHold = null;
    for (const viewer of session.viewers.values()) {
      send(viewer, { type: 'ended', reason });
      try {
        viewer.ws.close(1000, reason);
      } catch {
        void 0;
      }
    }
    session.viewers.clear();
  };

  const readFrame = async (response: Response) => {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > SURFACE_FRAME_MAX_BYTES) return null;
    const mime = (response.headers.get('content-type') || '').split(';')[0]?.trim();
    if (mime === undefined) throw new TypeError("Cannot read properties of undefined (reading 'trim')");
    if (!isFrameMime(mime)) return null;
    const seq = readDimension(response.headers.get(SURFACE_SEQ_HEADER));
    const width = readDimension(response.headers.get(SURFACE_WIDTH_HEADER));
    const height = readDimension(response.headers.get(SURFACE_HEIGHT_HEADER));
    if (seq === null || width === null || height === null) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > SURFACE_FRAME_MAX_BYTES) return null;
    const title = (response.headers.get(SURFACE_TITLE_HEADER) || '').slice(0, SURFACE_TITLE_MAX);
    const frame: SurfaceFrame = {
      seq,
      serviceSeq: seq,
      width,
      height,
      mime,
      bytes,
      agentActive: response.headers.get(SURFACE_AGENT_ACTIVE_HEADER) === '1',
    };
    if (title) frame.title = title;
    return frame;
  };

  const runPump = async (session: SurfaceSession) => {
    const abort = new AbortController();
    session.pumpAbort = abort;
    while (!abort.signal.aborted && session.viewers.size > 0) {
      const after = session.latest?.seq ?? 0;
      let opened;
      try {
        opened = await serviceRequest(session, {
          method: 'GET',
          path: SURFACE_FRAME_PATH,
          query: { after: String(after), wait: String(SURFACE_FRAME_WAIT_MS) },
          accept: SURFACE_FRAME_MIMES.join(', '),
          timeoutMs: SURFACE_FRAME_WAIT_MS + QUICK_REQUEST_TIMEOUT_MS,
          signal: abort.signal,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        const code = error instanceof GuestServiceError ? error.code : 'SERVICE_FAILED';
        endSession(session, code === 'DISABLED' || code === 'NO_SERVICE' ? 'extension-unavailable' : 'service-stopped');
        return;
      }
      const { response, finished } = opened;
      if (response.status === 204) {
        await response.arrayBuffer().catch(() => undefined);
        finished();
        continue;
      }
      if (response.status !== 200) {
        await response.arrayBuffer().catch(() => undefined);
        finished();
        endSession(session, 'service-stopped');
        return;
      }
      let frame;
      try {
        frame = await readFrame(response);
      } catch {
        frame = null;
      }
      finished();
      if (abort.signal.aborted) return;
      if (!frame) {
        endSession(session, 'service-stopped');
        return;
      }
      if (frame.seq <= after) frame.seq = after + 1;
      session.latest = frame;
      for (const viewer of session.viewers.values()) deliverLatest(session, viewer);
    }
  };

  const AUDIO_CODECS: ReadonlySet<string> = new Set(SURFACE_AUDIO_CODECS);
  const isAudioCodec = (value: string): value is (typeof SURFACE_AUDIO_CODECS)[number] => AUDIO_CODECS.has(value);
  // A service that does not answer sound requests is asked again only this
  // much later, so an extension without sound costs no steady traffic.
  const AUDIO_RETRY_MS = 30_000;
  // A listener whose socket holds this much unsent gets no more sound until
  // it catches up: a viewer that stopped reading (a locked phone) would
  // otherwise pile up sound in memory, and get it all at once when it wakes.
  const AUDIO_SEND_BUFFER_MAX = 1_000_000;

  const readAudio = async (response: Response) => {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > SURFACE_AUDIO_MAX_BYTES) return null;
    const seq = readDimension(response.headers.get(SURFACE_SEQ_HEADER));
    const codec = (response.headers.get(SURFACE_AUDIO_CODEC_HEADER) || '').trim();
    const sampleRate = readDimension(response.headers.get(SURFACE_AUDIO_SAMPLE_RATE_HEADER));
    const channels = readDimension(response.headers.get(SURFACE_AUDIO_CHANNELS_HEADER));
    if (seq === null || !isAudioCodec(codec) || sampleRate === null || channels === null) return null;
    if (sampleRate < SURFACE_AUDIO_SAMPLE_RATE_MIN || sampleRate > SURFACE_AUDIO_SAMPLE_RATE_MAX || channels > SURFACE_AUDIO_CHANNELS_MAX) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > SURFACE_AUDIO_MAX_BYTES) return null;
    // Whole packets only: a viewer decodes them one by one.
    let offset = 0;
    while (offset < bytes.length) {
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length === 0 || offset + 2 + length > bytes.length) return null;
      offset += 2 + length;
    }
    return { seq, codec, sampleRate, channels, bytes };
  };

  const listening = (session: SurfaceSession) => [...session.viewers.values()].some((viewer) => viewer.audio);

  const setAudioAvailable = (session: SurfaceSession, available: boolean) => {
    if (session.audioUnavailable === !available) return;
    session.audioUnavailable = !available;
    for (const viewer of session.viewers.values()) {
      if (viewer.audio) send(viewer, { type: 'audio-state', available });
    }
  };

  /**
   * Asks the service for sound while at least one viewer listens, and hands
   * each listening viewer every batch, with no acks: sound is a few kilobytes
   * a second. A viewer whose socket is backed up gets none until it catches
   * up (`AUDIO_SEND_BUFFER_MAX`); its player drops what arrives too late. A
   * service without sound (404, or any other failure) is told once to the
   * listeners and asked again later, and the first batch after that says the
   * sound is back; sound never ends the session.
   */
  const runAudioPump = async (session: SurfaceSession) => {
    const abort = new AbortController();
    session.audioAbort = abort;
    session.audioUnavailable = false;
    let after = 0;
    const pause = (ms: number) => new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimer(timer);
        resolve();
      };
      const timer = setTimer(() => {
        abort.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    while (!abort.signal.aborted && !session.ended && listening(session)) {
      let opened;
      try {
        opened = await serviceRequest(session, {
          method: 'GET',
          path: SURFACE_AUDIO_PATH,
          query: { after: String(after), wait: String(SURFACE_FRAME_WAIT_MS) },
          accept: 'application/octet-stream',
          timeoutMs: SURFACE_FRAME_WAIT_MS + QUICK_REQUEST_TIMEOUT_MS,
          signal: abort.signal,
        });
      } catch {
        if (abort.signal.aborted) break;
        setAudioAvailable(session, false);
        await pause(AUDIO_RETRY_MS);
        continue;
      }
      const { response, finished } = opened;
      if (response.status === 204) {
        await response.arrayBuffer().catch(() => undefined);
        finished();
        continue;
      }
      let batch = null;
      // A broken batch that still says which packet it ends at is skipped, so
      // the next request does not get the same one back.
      const brokenSeq = readDimension(response.headers.get(SURFACE_SEQ_HEADER));
      if (response.status === 200) {
        try {
          batch = await readAudio(response);
        } catch {
          batch = null;
        }
      } else {
        await response.arrayBuffer().catch(() => undefined);
      }
      finished();
      if (abort.signal.aborted) break;
      if (!batch) {
        if (response.status === 200 && brokenSeq !== null && brokenSeq > after) after = brokenSeq;
        setAudioAvailable(session, false);
        await pause(AUDIO_RETRY_MS);
        continue;
      }
      after = batch.seq;
      setAudioAvailable(session, true);
      const meta: Extract<SurfaceHostMessage, { type: 'audio' }> = { type: 'audio', seq: batch.seq, codec: batch.codec, sampleRate: batch.sampleRate, channels: batch.channels, bytes: batch.bytes.length };
      for (const viewer of session.viewers.values()) {
        if (!viewer.audio || viewer.ws.readyState !== 1) continue;
        if ((typeof viewer.ws.bufferedAmount === 'number' ? viewer.ws.bufferedAmount : 0) > AUDIO_SEND_BUFFER_MAX) continue;
        send(viewer, meta);
        try {
          viewer.ws.send(batch.bytes, { binary: true });
        } catch {
          // close handler cleans up
        }
      }
    }
    if (session.audioAbort === abort) session.audioAbort = null;
  };

  const setViewerAudio = (session: SurfaceSession, viewer: SurfaceViewer, enabled: boolean) => {
    viewer.audio = enabled;
    if (enabled) {
      if (!session.audioAbort) void runAudioPump(session);
      // Joining a pump that already found no sound: say so now, not at its next try.
      else if (session.audioUnavailable) send(viewer, { type: 'audio-state', available: false });
      return;
    }
    if (!listening(session)) {
      session.audioAbort?.abort();
      session.audioAbort = null;
    }
  };

  const ensureSession = (guestId: string, guest: SurfaceGuest) => {
    let session = sessions.get(guestId);
    if (session) {
      session.guest = guest;
      return session;
    }
    session = {
      guestId,
      guest,
      viewers: new Map(),
      latest: null,
      controller: 'none',
      agentTimer: null,
      pumpAbort: null,
      audioAbort: null,
      audioUnavailable: false,
      releaseHold: holdService(guestId),
      ended: false,
      queue: Promise.resolve(),
      handoffs: 0,
    };
    sessions.set(guestId, session);
    return session;
  };

  const isDeliberate = (events: Extract<SurfaceViewerMessage, { type: 'input' }>['events']) => events.some((event) => (
    event.type !== 'pointer' || event.action !== 'move' || event.buttons !== 0
  ));

  const handleInput = async (session: SurfaceSession, viewer: SurfaceViewer, events: Extract<SurfaceViewerMessage, { type: 'input' }>['events'], handoff: number, frameSeq: number) => {
    if (viewer.gone) return;
    if (session.controller !== viewer.id) {
      if (session.controller !== 'none' && session.controller !== 'agent') {
        send(viewer, { type: 'control', controller: 'user', mine: false });
        return;
      }
      if (!isDeliberate(events) || handoff !== session.handoffs) return;
      setController(session, viewer.id);
    }
    try {
      const { response, finished } = await serviceRequest(session, {
        method: 'POST',
        path: SURFACE_INPUT_PATH,
        body: JSON.stringify({ events }),
        headers: {
          [SURFACE_VIEWER_HEADER]: viewer.id,
          [SURFACE_FRAME_SEQ_HEADER]: String(frameSeq),
        },
        timeoutMs: QUICK_REQUEST_TIMEOUT_MS,
      });
      await response.arrayBuffer().catch(() => undefined);
      finished();
      if (response.status === 409) {
        send(viewer, { type: 'error', code: 'INPUT_STALE', message: 'The picture changed before this input arrived; it was not applied.' });
        return;
      }
      if (response.status < 200 || response.status >= 300) {
        send(viewer, { type: 'error', code: 'INPUT_REJECTED', message: `The extension refused this input (HTTP ${response.status}).` });
      }
    } catch (error) {
      send(viewer, { type: 'error', code: 'INPUT_FAILED', message: error instanceof GuestServiceError ? error.message : 'The input could not be delivered.' });
    }
  };

  const handleResize = async (session: SurfaceSession, viewer: SurfaceViewer, width: number, height: number) => {
    if (session.controller !== viewer.id && session.controller !== 'none' && session.controller !== 'agent') return;
    try {
      const { response, finished } = await serviceRequest(session, {
        method: 'POST',
        path: SURFACE_RESIZE_PATH,
        body: JSON.stringify({ width, height }),
        timeoutMs: QUICK_REQUEST_TIMEOUT_MS,
      });
      const text = await response.text().catch(() => '');
      finished();
      if (response.status !== 200) return;
      let parsed: ReturnType<typeof surfaceResizeAnswerSchema.safeParse> | { success: false };
      try {
        parsed = surfaceResizeAnswerSchema.safeParse(JSON.parse(text));
      } catch {
        parsed = { success: false };
      }
      if (parsed.success) send(viewer, { type: 'resized', width: parsed.data.width, height: parsed.data.height });
    } catch {
      void 0;
    }
  };

  const handleClipboardRead = async (session: SurfaceSession, viewer: SurfaceViewer, id: string) => {
    if (session.controller !== viewer.id) {
      send(viewer, { type: 'error', code: 'NOT_CONTROLLING', message: 'Take control of the surface to copy from it.' });
      return;
    }
    try {
      const { response, finished } = await serviceRequest(session, {
        method: 'GET',
        path: SURFACE_CLIPBOARD_PATH,
        timeoutMs: QUICK_REQUEST_TIMEOUT_MS,
      });
      const text = await response.text().catch(() => '');
      finished();
      let parsed: ReturnType<typeof surfaceClipboardAnswerSchema.safeParse> | { success: false };
      try {
        parsed = response.status === 200 ? surfaceClipboardAnswerSchema.safeParse(JSON.parse(text)) : { success: false };
      } catch {
        parsed = { success: false };
      }
      if (!parsed.success) {
        send(viewer, { type: 'error', code: 'CLIPBOARD_UNAVAILABLE', message: 'The extension did not provide clipboard text.' });
        return;
      }
      send(viewer, { type: 'clipboard', id, text: parsed.data.text });
    } catch {
      send(viewer, { type: 'error', code: 'CLIPBOARD_UNAVAILABLE', message: 'The extension did not provide clipboard text.' });
    }
  };

  const handleViewerMessage = (session: SurfaceSession, viewer: SurfaceViewer, raw: RawData) => {
    let parsed: ReturnType<typeof surfaceViewerMessageSchema.safeParse> | { success: false };
    try {
      parsed = surfaceViewerMessageSchema.safeParse(JSON.parse(Buffer.from(raw).toString('utf8')));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) {
      send(viewer, { type: 'error', code: 'BAD_MESSAGE', message: 'Not a surface message.' });
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'ack': {
        // Cumulative: an ack covers every earlier frame still in flight, which
        // the viewer skipped for this newer one. An ack for a frame no longer
        // in flight (it arrived after a newer one's) changes nothing.
        const acked = viewer.inFlight.findIndex((sent) => sent.seq === message.seq);
        const frame = viewer.inFlight[acked];
        if (!frame) return;
        // Acknowledged after drawing: this is the picture its next input is made on.
        viewer.shownServiceSeq = frame.serviceSeq;
        viewer.inFlight.splice(0, acked + 1);
        deliverLatest(session, viewer);
        return;
      }
      case 'input': {
        const handoff = session.handoffs;
        const frameSeq = viewer.shownServiceSeq;
        void enqueue(session, () => handleInput(session, viewer, message.events, handoff, frameSeq));
        return;
      }
      case 'release':
        if (session.controller === viewer.id) {
          session.handoffs += 1;
          setController(session, 'none');
        }
        return;
      case 'resize':
        void enqueue(session, () => handleResize(session, viewer, message.width, message.height));
        return;
      case 'clipboard-read':
        void enqueue(session, () => handleClipboardRead(session, viewer, message.id));
        return;
      case 'audio':
        setViewerAudio(session, viewer, message.enabled);
        return;
    }
  };

  const attachViewer = (guestId: string, guest: SurfaceGuest, ws: WebSocket, framesInFlight: number) => {
    const session = ensureSession(guestId, guest);
    const viewer: SurfaceViewer = { id: createViewerId(), ws, sentSeq: 0, shownServiceSeq: 0, framesInFlight, inFlight: [], audio: false, gone: false };
    session.viewers.set(viewer.id, viewer);
    if (!session.pumpAbort) void runPump(session);
    send(viewer, { type: 'hello', viewerId: viewer.id });
    send(viewer, { type: 'control', controller: controllerKind(session), mine: false });
    deliverLatest(session, viewer);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      handleViewerMessage(session, viewer, raw);
    });
    ws.on('close', () => {
      viewer.gone = true;
      session.viewers.delete(viewer.id);
      if (session.ended) return;
      if (viewer.audio) setViewerAudio(session, viewer, false);
      const held = session.controller === viewer.id;
      if (held) {
        session.handoffs += 1;
        setController(session, 'none');
      }
      if (session.viewers.size > 0) return;
      clearAgentTimer(session);
      session.pumpAbort?.abort();
      session.pumpAbort = null;
      void session.queue.then(() => {
        if (session.ended || session.viewers.size > 0) return;
        session.ended = true;
        sessions.delete(guestId);
        session.releaseHold?.();
        session.releaseHold = null;
      });
    });
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        void 0;
      }
    });
  };

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: VIEWER_MESSAGE_MAX_BYTES });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return;
    }
    const { pathname } = url;
    const match = SURFACE_WS_PATH.exec(pathname);
    if (!match) return;
    const guestId = match[1];
    if (guestId === undefined) throw new Error('Surface route capture is missing');

    const handleUpgrade = async () => {
      try {
        if (isOpaqueOriginRequest(req)) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        if (!uiAuthController?.enabled && !await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed)) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }
          if (!await isRequestOriginAllowed(req)) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }
        const guest = await findGuest(guestId).catch(() => null);
        if (!isSurfaceGuest(guest)) {
          rejectWebSocketUpgrade(socket, 404, 'No surface for this extension');
          return;
        }
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          attachViewer(guestId, guest, ws, readFramesInFlight(url.searchParams));
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };
    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);

  return {
    userControls(guestId: string) {
      const session = sessions.get(guestId);
      return !!session && session.controller !== 'none' && session.controller !== 'agent';
    },

    noteAgentActivity(guestId: string) {
      const session = sessions.get(guestId);
      if (!session || (session.controller !== 'none' && session.controller !== 'agent')) return;
      const first = session.controller !== 'agent';
      session.controller = 'agent';
      clearAgentTimer(session);
      session.agentTimer = setTimer(() => {
        session.agentTimer = null;
        if (session.controller === 'agent') setController(session, 'none');
      }, SURFACE_AGENT_HOLD_MS);
      session.agentTimer.unref?.();
      if (first) broadcastControl(session);
    },

    endForGuest(guestId: string) {
      const session = sessions.get(guestId);
      if (session) endSession(session, 'extension-unavailable');
    },

    viewerHeaders(guestId: string, viewerId: string) {
      const session = sessions.get(guestId);
      const viewer = session && !session.ended ? session.viewers.get(viewerId) : undefined;
      if (!session || !viewer || viewer.gone) return null;
      return {
        [SURFACE_VIEWER_HEADER]: viewer.id,
        [SURFACE_VIEWER_CONTROLS_HEADER]: session.controller === viewer.id ? '1' : '0',
        [SURFACE_FRAME_SEQ_HEADER]: String(viewer.shownServiceSeq),
      };
    },

    sessionOf(guestId: string) {
      return sessions.get(guestId) ?? null;
    },

    stop() {
      server.off('upgrade', upgradeHandler);
      for (const session of [...sessions.values()]) endSession(session, 'host-shutdown');
      const clients = wsServer.clients;
      if (clients === undefined) throw new TypeError('wsServer.clients is not iterable');
      for (const client of clients) {
        try {
          client.close(1001, 'server shutting down');
        } catch {
          void 0;
        }
      }
      wsServer.close();
    },
  };
};
