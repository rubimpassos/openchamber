import http from 'node:http';
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { z } from 'zod';
import { isString } from '../shared/guards.js';
import type {} from '../relay/platform.js';
import type {} from '../opencode/dependency-contracts.js';
import type { JsonValue } from '../event-stream/contracts.js';

import { AgentServerModeError, readAgentServerMode } from './mode.js';
import type { AgentUpstreamConfiguration } from './mode.js';

export type AgentUpstreamErrorCode = 'agent_stream_too_large' | 'agent_response_too_large'
  | 'agent_invalid_path' | 'agent_unreachable' | 'agent_redirected' | 'agent_login_failed'
  | 'agent_session_expired' | 'agent_invalid_response' | 'agent_control_unavailable';
export type AgentUpstreamOptions = AgentUpstreamConfiguration & {
  readonly now?: () => number;
  readonly maxBytes?: number;
  readonly eventBytes?: number;
  readonly timeoutMs?: number;
};
export type AgentRequestBody = string | Uint8Array | Readable;
export type AgentRequestOptions = {
  readonly path: string;
  readonly method?: string | undefined;
  readonly headers?: OutgoingHttpHeaders | undefined;
  readonly body?: AgentRequestBody | null | undefined;
  readonly signal?: AbortSignal | null | undefined;
  readonly timeoutMs?: number | undefined;
};
export type AgentFetchOptions = Omit<RequestInit, 'body'> & {
  readonly body?: BodyInit | AgentRequestBody | null | undefined;
};
export interface AgentUpstreamResponse extends IncomingMessage {
  readonly statusCode: number;
}
type AgentSession = { readonly cookie: string; readonly renewAt: number };
type BoundedResponse = AsyncIterable<Uint8Array> & Pick<Readable, 'destroy'> & { readonly complete?: boolean };

export class AgentUpstreamError extends Error {
  readonly code: AgentUpstreamErrorCode;
  constructor(code: AgentUpstreamErrorCode) { super(code); this.code = code; }
}

export function boundedEventStream(source: Readable, cap: number): Transform {
  let eventBytes = 0;
  let lineBytes = 0;
  let previousCR = false;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        if (previousCR && byte === 10) { previousCR = false; continue; }
        previousCR = byte === 13;
        if (byte === 10 || byte === 13) {
          if (lineBytes === 0) eventBytes = 0;
          lineBytes = 0;
        } else {
          lineBytes += 1;
        }
        eventBytes += 1;
        if (lineBytes > cap || eventBytes > cap) {
          callback(new AgentUpstreamError('agent_stream_too_large'));
          return;
        }
      }
      callback(null, chunk);
    },
  });
  source.once('error', (error) => bounded.destroy(error));
  bounded.once('close', () => source.destroy());
  source.pipe(bounded);
  return bounded;
}

export async function readBoundedBody(response: BoundedResponse, cap: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > cap) throw new AgentUpstreamError('agent_response_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { if (!response.complete) response.destroy(); }
}

const requestPathSchema = z.string().refine((value) => value.startsWith('/') && !value.startsWith('//') && !/[\r\n\\#]/.test(value));

export function createAgentUpstream({ url, token, now = Date.now, maxBytes = 4 * 1024 * 1024, eventBytes = 1024 * 1024, timeoutMs = 30_000 }: AgentUpstreamOptions) {
  const config = readAgentServerMode({ OPENCHAMBER_AGENT_SERVER_URL: url, OPENCHAMBER_AGENT_SERVER_TOKEN: token }).upstream;
  if (!config) throw new AgentServerModeError('Front door requires OPENCHAMBER_AGENT_SERVER_URL and OPENCHAMBER_AGENT_SERVER_TOKEN.');
  const base = new URL(config.url);
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  const port = Number(base.port || 80);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32, timeout: 4_000 });
  const requestOptions = { hostname, port, agent };
  const active = new Set<ClientRequest>();
  let session: AgentSession | null = null;
  let login: Promise<string> | null = null;
  let closed = false;

  const requestPath = (value: string) => {
    const parsed = requestPathSchema.safeParse(value);
    if (!parsed.success) throw new AgentUpstreamError('agent_invalid_path');
    return parsed.data;
  };
  const once = ({ method = 'GET', path, headers = {}, body = null, signal, timeoutMs: deadline = timeoutMs }: AgentRequestOptions): Promise<AgentUpstreamResponse> => new Promise((resolve, reject) => {
    if (closed) { reject(new AgentUpstreamError('agent_unreachable')); return; }
    const req = http.request({ ...requestOptions, method, path: requestPath(path), headers: { ...headers, host: base.host, 'accept-encoding': 'identity' }, signal: signal ?? undefined });
    active.add(req);
    const timer = setTimeout(() => req.destroy(new AgentUpstreamError('agent_unreachable')), deadline > 0 ? deadline : timeoutMs);
    timer?.unref();
    req.setTimeout(0);
    req.once('close', () => { clearTimeout(timer); active.delete(req); });
    req.once('response', (response: AgentUpstreamResponse) => { if (deadline === 0) clearTimeout(timer); resolve(response); });
    req.once('error', (error) => reject(error instanceof AgentUpstreamError ? error : new AgentUpstreamError('agent_unreachable')));
    if (body instanceof Readable) {
      const failed = () => req.destroy(new AgentUpstreamError('agent_unreachable'));
      body.once('error', failed);
      req.once('close', () => { body.removeListener('error', failed); body.unpipe(req); body.destroy(); });
      body.pipe(req);
    }
    else req.end(body ?? undefined);
  });

  const renew = (): Promise<string> => {
    if (login) return login;
    session = null;
    login = (async () => {
      const response = await once({ method: 'POST', path: '/auth/session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: token }) });
      const line = response.headers['set-cookie']?.find((entry) => /^oc_ui_session(?:_\d+)?=/.test(entry));
      await readBoundedBody(response, 64 * 1024);
      if (response.statusCode >= 300 && response.statusCode < 400) throw new AgentUpstreamError('agent_redirected');
      const match = line?.match(/^(oc_ui_session(?:_\d+)?=[^;\r\n]+);.*\bMax-Age=(\d+)(?:;|$)/i);
      const ttl = Number(match?.[2]);
      const cookie = match?.[1];
      if (response.statusCode !== 200 || !cookie || !Number.isSafeInteger(ttl) || ttl <= 0) throw new AgentUpstreamError('agent_login_failed');
      session = { cookie, renewAt: now() + ttl * 900 };
      return session.cookie;
    })().finally(() => { login = null; });
    return login;
  };
  const cookieFor = () => session && now() < session.renewAt ? Promise.resolve(session.cookie) : renew();
  const request = async (options: AgentRequestOptions): Promise<AgentUpstreamResponse> => {
    const cookie = await cookieFor();
    const send = (value: string) => once({ ...options, headers: { ...options.headers, cookie: value } });
    const hasBody = options.body !== null && options.body !== undefined || options.headers?.['content-length'] !== undefined || options.headers?.['transfer-encoding'] !== undefined;
    let response;
    try { response = await send(cookie); }
    catch (error) {
      if (hasBody || options.signal?.aborted || !(error instanceof AgentUpstreamError) || error.code !== 'agent_unreachable') throw error;
      response = await send(cookie);
    }
    if (response.statusCode === 401) {
      response.destroy();
      const fresh = await renew();
      if (hasBody) throw new AgentUpstreamError('agent_session_expired');
      response = await send(fresh);
      if (response.statusCode === 401) { response.destroy(); throw new AgentUpstreamError('agent_login_failed'); }
    }
    if (response.statusCode >= 300 && response.statusCode < 400 && response.statusCode !== 304) {
      response.destroy();
      throw new AgentUpstreamError('agent_redirected');
    }
    return response;
  };
  const json = async (path: string, options: Omit<AgentRequestOptions, 'path'> = {}): Promise<JsonValue> => {
    const response = await request({ ...options, path });
    const body = await readBoundedBody(response, maxBytes);
    if (response.statusCode < 200 || response.statusCode >= 300) throw new AgentUpstreamError('agent_unreachable');
    try { return JSON.parse(body); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new AgentUpstreamError('agent_invalid_response');
    }
  };
  const fetchAdapter = async (input: string | URL | Request, options: AgentFetchOptions = {}): Promise<Response> => {
    const incomingRequest = input instanceof Request ? input : null;
    const requested = new URL(input instanceof Request ? input.url : input, base);
    if (requested.origin !== base.origin) throw new AgentUpstreamError('agent_invalid_path');
    const headersIn = new Headers(options.headers ?? incomingRequest?.headers);
    const body = options.body ?? incomingRequest?.body;
    if (body != null && !isString(body) && !(body instanceof Uint8Array) && !(body instanceof Readable) && !(body instanceof ReadableStream)) {
      throw new TypeError('Unsupported agent request body');
    }
    const sse = /text\/event-stream/i.test(headersIn.get('accept') ?? '');
    const response = await request({
      ...options, method: options.method ?? incomingRequest?.method, signal: options.signal ?? incomingRequest?.signal,
      body: body instanceof ReadableStream ? Readable.fromWeb(body) : body,
      path: `${requested.pathname}${requested.search}`, headers: Object.fromEntries(headersIn), timeoutMs: sse ? 0 : timeoutMs,
    });
    const headers = new Headers();
    for (const key of ['content-type', 'x-next-cursor']) if (response.headers[key]) headers.set(key, String(response.headers[key]));
    const status = response.statusCode;
    if (status === 204 || status === 304) { response.destroy(); return new Response(null, { status, headers }); }
    const responseBody = sse && status === 200
      ? Readable.toWeb(boundedEventStream(response, eventBytes))
      : await readBoundedBody(response, maxBytes);
    return new Response(responseBody, { status, headers });
  };
  return {
    request, json, fetch: fetchAdapter, cookieFor, renew, requestOptions,
    host: base.host, origin: base.origin, buildUrl: (path: string) => `${base.origin}${requestPath(path)}`,
    connect: () => new Promise<net.Socket>((resolve, reject) => { const socket = net.connect({ host: hostname, port }); socket.once('connect', () => resolve(socket)); socket.once('error', reject); }),
    close() { closed = true; for (const req of active) req.destroy(); agent.destroy(); session = null; },
  };
}

export type AgentUpstream = ReturnType<typeof createAgentUpstream>;
