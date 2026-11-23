import { z } from 'zod';
import { createSpaceDispatcher, forwardRequestHeaders, requestedDirectories, stripCredentialQuery } from '../spaces/dispatcher.js';
import { createSpaceWebSocketForwarder } from '../spaces/websocket.js';
import { sanitizeSessionListItem, writeSseChunkWithBackpressure } from '../opencode/proxy.js';
import { classify, normalizedRequestUrl } from './ownership.js';
import { isAgentPayloadAllowed } from './session-boundary.js';
import { stripProvenance } from './stream-fields.js';
import { isJsonObject } from '../event-stream/guards.js';
import type { Request, RequestHandler, Response } from '../shared/http-contracts.js';
import type { JsonValue } from '../event-stream/contracts.js';
import type { GlobalMessageStreamHub } from '../event-stream/global-hub.js';
import type { createSpacesHost } from '../spaces/host.js';
import type { AgentUpstream } from './agent-upstream.js';

type SocketOptions = Parameters<typeof createSpaceWebSocketForwarder>[0];
type FrontDoorOptions = Pick<SocketOptions, 'uiAuthController' | 'isRequestOriginAllowed'> & {
  readonly upstream: AgentUpstream;
  readonly getSpacesHost: () => Pick<ReturnType<typeof createSpacesHost>, 'index' | 'middleware' | 'mergeSessionList'> | null;
  readonly hub: Pick<GlobalMessageStreamHub, 'start' | 'subscribeEvent'>;
  readonly maxEventQueueBytes?: number;
};

const listSchema = z.union([
  z.array(z.object({ id: z.string() }).catchall(z.json())),
  z.object({ data: z.array(z.object({ id: z.string() }).catchall(z.json())), cursor: z.object({ next: z.string().nullish() }).nullish() }),
]);
const upstreamFailure = z.object({ code: z.enum(['agent_login_failed', 'agent_session_expired', 'agent_redirected']) });

export const frontDoorRequestGate: RequestHandler = (req, res, next) => {
  const url = normalizedRequestUrl(req);
  if (/^\/api\/openchamber\/(?:host-credentials|fix-loop-services|bot-services)(?:\/|$)/i.test(url?.pathname ?? '')) return res.status(403).json({ code: 'front_door_refused' });
  if (!url || classify(req) === 'refused') return res.status(403).json({ code: 'front_door_refused', error: 'This action is unavailable in front door mode.' });
  req.url = `${url.pathname}${url.search}`;
  req.originalUrl = req.url;
  next();
};

export function createFrontDoor({ upstream, getSpacesHost, hub, uiAuthController, isRequestOriginAllowed, maxEventQueueBytes = 2 * 1024 * 1024 }: FrontDoorOptions) {
  const isSpaceSession = (id: string) => Boolean(getSpacesHost()?.index?.claimedBy(id));
  const dispatcher = createSpaceDispatcher({ upstream });
  const sockets = createSpaceWebSocketForwarder({
    dispatcher, connect: upstream.connect, uiAuthController, isRequestOriginAllowed,
    target: { host: upstream.host, routeOf: (req, url) => classify(req) === 'agent' ? { spaceId: 'agent', path: url.pathname } : null },
  });
  const serveEvents = (req: Request, res: Response) => {
    const url = normalizedRequestUrl(req);
    if (!url) return res.status(403).json({ code: 'front_door_refused' });
    const directories = requestedDirectories(req, url);
    const stop = new AbortController();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    const queue: string[] = [];
    let queuedBytes = 0;
    let draining = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length && !stop.signal.aborted) {
          const block = queue[0];
          if (block === undefined || !await writeSseChunkWithBackpressure(res, block, stop.signal)) break;
          queue.shift();
          queuedBytes -= Buffer.byteLength(block);
        }
      } catch { res.destroy(); }
      finally { draining = false; }
    };
    const send = (block: string) => {
      queuedBytes += Buffer.byteLength(block);
      if (queuedBytes > maxEventQueueBytes) return res.destroy();
      queue.push(block);
      void drain();
    };
    const unsubscribe = hub.subscribeEvent((event) => {
      if (directories.length && !directories.includes(event.directory)) return;
      if (!isJsonObject(event.payload)) return;
      const payload = { ...event.payload, directory: event.directory, origin: event.origin, spaceId: event.spaceId };
      send(`id: ${event.eventId}\ndata: ${JSON.stringify(payload)}\n\n`);
    }, { spaces: true });
    const heartbeat = setInterval(() => send(':heartbeat\n\n'), 20_000);
    res.once('close', () => { stop.abort(); queue.length = 0; queuedBytes = 0; clearInterval(heartbeat); unsubscribe(); });
    send(':connected\n\n');
    hub.start();
  };
  const middleware: RequestHandler = async (req, res, next) => {
    const owner = classify(req);
    const url = normalizedRequestUrl(req);
    if (owner === 'space') {
      const host = getSpacesHost();
      return host ? host.middleware(req, res, next) : res.status(404).json({ code: 'space_not_found', error: 'There is no such space.' });
    }
    if (owner !== 'agent') return next();
    if (!url) return res.status(403).json({ code: 'front_door_refused' });
    const actedSession = /^\/api\/session\/([^/]+)/i.exec(url.pathname)?.[1];
    if (actedSession && isSpaceSession(actedSession)) return res.status(403).json({ code: 'agent_session_refused', error: 'The session belongs to a space.' });
    stripCredentialQuery(url);
    try {
      if (req.method === 'GET' && url.pathname.toLowerCase() === '/api/session') {
        const payload = listSchema.parse(await upstream.json(`${url.pathname}${url.search}`, { headers: forwardRequestHeaders(req.headers, '', upstream.host) }));
        const sanitize = (records: readonly JsonValue[]) => records.filter((record) => isAgentPayloadAllowed(record, isSpaceSession)).map(sanitizeSessionListItem);
        const clean = Array.isArray(payload) ? sanitize(payload) : { ...payload, data: sanitize(payload.data) };
        const merge = !url.searchParams.has('cursor') && !requestedDirectories(req, url).some(Boolean);
        const spaces = getSpacesHost();
        return res.json(merge && spaces ? await spaces.mergeSessionList(clean) : clean);
      }
      if (req.method === 'GET' && /^\/api\/session\/[^/]+$/i.test(url.pathname)) {
        const payload = await upstream.json(`${url.pathname}${url.search}`, { headers: forwardRequestHeaders(req.headers, '', upstream.host) });
        if (!isAgentPayloadAllowed(payload, isSpaceSession)) return res.status(502).json({ code: 'agent_session_refused', error: 'Invalid agent session identity.' });
        return res.json(stripProvenance(payload));
      }
      await dispatcher.forwardRequest(req, res, url.pathname, url.search);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const code = upstreamFailure.safeParse(error).data?.code ?? 'agent_unreachable';
      res.status(code === 'agent_session_expired' ? 503 : 502).json({ error: code, code });
    }
  };
  const upgradeHandler: typeof sockets.upgradeHandler = (req, socket, head) => {
    const url = normalizedRequestUrl(req);
    if (url) {
      if (['/api/global/event/ws', '/api/event/ws', '/api/terminal/ws', '/api/dev-tunnel'].includes(url.pathname.toLowerCase())) url.pathname = url.pathname.toLowerCase();
      req.url = `${url.pathname}${url.search}`;
      req.originalUrl = req.url;
    }
    const owner = classify(req);
    if (owner === 'space') {
      if (!getSpacesHost()) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (owner === 'local') return;
    if (owner === 'agent') return sockets.upgradeHandler(req, socket, head);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  };
  return { middleware, serveEvents, upgradeHandler, close() { sockets.close(); dispatcher.close(); upstream.close(); } };
}
