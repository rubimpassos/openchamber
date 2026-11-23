import { isPlainObject, isRecord, isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { MAX_FRAME_BYTES } from './contract.js';
import type { ConnectionId } from './contract.js';
import type { StoredDefinition } from './definition-types.js';
import type { McpBackend } from './mcp-session.js';

type HttpConnection = Extract<StoredDefinition, { transport: 'http' }>;
type OAuthTokens = { readonly accessToken: string };
type HttpUpstreamOptions = {
  readonly definition: HttpConnection;
  readonly credentials: { readonly secrets: Readonly<JsonObject> };
  readonly oauth: {
    readonly tokensFor: (definition: HttpConnection, options: { readonly refresh: boolean }) => Promise<OAuthTokens>;
    readonly markUnauthorized: (definition: HttpConnection, options: { readonly tokens: OAuthTokens | null }) => Promise<void>;
  };
  readonly fetchImpl?: typeof fetch;
  readonly unavailable: (reason: 'authorization_required') => string;
  readonly log?: (event: string, fields: { readonly connection: ConnectionId }) => void;
};
type RequestOptions = { readonly refresh?: boolean; readonly accept?: string | undefined };

const MAX_RESPONSE_BYTES = 4 * MAX_FRAME_BYTES;
const DELETE_TIMEOUT_MS = 2000;

const isRequest = (message: JsonObject) => isPlainObject(message) && isString(message.method) && message.id !== undefined && message.id !== null;

async function readText(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readEvents(body: ReadableStream<Uint8Array>, onValue: (value: JsonValue) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length === 0) return;
    const text = data.join('\n');
    data = [];
    try {
      onValue(JSON.parse(text));
    } catch { return; }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > MAX_FRAME_BYTES) {
      await reader.cancel();
      throw new Error('event too large');
    }
    let index;
    while ((index = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer.startsWith('\r\n', index) ? 2 : 1));
      if (line === '') dispatch();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  dispatch();
}

export function startHttpUpstream({ definition, credentials, oauth, fetchImpl = fetch, unavailable, log = () => {} }: HttpUpstreamOptions): McpBackend {
  const { url } = definition.http;
  const controllers = new Set<AbortController>();
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let closed = false;
  let streamOpened = false;
  let onMessage: (message: JsonValue) => void = () => {};
  let onClose = () => {};
  const emit = (message: JsonValue) => {
    if (!closed) onMessage(message);
  };
  const fail = (message: JsonObject, code: number, text: string) => {
    if (isRequest(message)) emit({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  };

  const headersFor = async ({ refresh = false, accept = 'application/json, text/event-stream' }: RequestOptions = {}) => {
    const headers = Object.fromEntries([['accept', accept]]);
    for (const [name, value] of Object.entries(definition.http.headers)) {
      headers[name] = isString(value) ? value : `${value.prefix ?? ''}${credentials.secrets[value.secret]}`;
    }
    let tokens: OAuthTokens | null = null;
    if (definition.http.oauth) {
      tokens = await oauth.tokensFor(definition, { refresh });
      headers.authorization = `Bearer ${tokens.accessToken}`;
    }
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    return { headers, tokens };
  };

  const request = async (init: RequestInit, { refresh = false, accept }: RequestOptions = {}) => {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const { headers, tokens } = await headersFor({ refresh, accept });
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetchImpl(url, { ...init, headers, redirect: 'manual', signal: controller.signal });
      return { response, tokens, release: () => controllers.delete(controller) };
    } catch (error) {
      controllers.delete(controller);
      throw error;
    }
  };

  const post = async (message: JsonObject, retried = false): Promise<void> => {
    let exchange;
    try {
      exchange = await request({ method: 'POST', body: JSON.stringify(message) }, { refresh: retried });
    } catch (error) {
      if (isRecord(error) && error.code === 'authorization_required') return fail(message, -32001, unavailable('authorization_required'));
      if (!closed) fail(message, -32603, 'The protected MCP service could not reach the upstream server.');
      return undefined;
    }
    const { response, tokens, release } = exchange;
    try {
      if ((response.status === 401 || response.status === 403) && definition.http.oauth && !retried) {
        await response.body?.cancel();
        release();
        return post(message, true);
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        if (definition.http.oauth) await oauth.markUnauthorized(definition, { tokens });
        return fail(message, -32001, unavailable('authorization_required'));
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        log('upstream_redirect_refused', { connection: definition.id });
        return fail(message, -32603, 'The upstream server answered with a redirect, which the protected MCP service does not follow.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        return fail(message, -32603, `The upstream server answered HTTP ${response.status}.`);
      }
      if (message.method === 'initialize') sessionId = response.headers.get('mcp-session-id') ?? sessionId;
      const handle = (value: JsonValue) => {
        if (message.method === 'initialize' && isPlainObject(value) && value.id === message.id && isPlainObject(value.result) && isString(value.result.protocolVersion)) protocolVersion = value.result.protocolVersion;
        if (Array.isArray(value)) value.forEach(emit);
        else emit(value);
      };
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (response.status === 202 || !response.body) return undefined;
      if (type.startsWith('text/event-stream')) await readEvents(response.body, handle);
      else if (type.includes('json')) handle(JSON.parse(await readText(response.body, MAX_RESPONSE_BYTES)));
      else await response.body.cancel();
      return undefined;
    } catch {
      if (!closed) fail(message, -32603, 'The upstream server sent an answer the protected MCP service could not read.');
      return undefined;
    } finally {
      release();
    }
  };

  const openStream = async () => {
    if (streamOpened || closed) return;
    streamOpened = true;
    try {
      const { response, release } = await request({ method: 'GET' }, { accept: 'text/event-stream' });
      try {
        if (response.ok && (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream') && response.body) {
          await readEvents(response.body, (value) => emit(value));
        } else await response.body?.cancel();
      } finally {
        release();
      }
    } catch { return; }
  };

  return {
    send(message) {
      if (closed) return;
      const sent = post(message);
      if (isPlainObject(message) && message.method === 'notifications/initialized') sent.then(openStream);
    },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      if (sessionId) {
        const signal = AbortSignal.timeout(DELETE_TIMEOUT_MS);
        headersFor().then(({ headers }) => fetchImpl(url, { method: 'DELETE', headers, redirect: 'manual', signal }))
          .then((response) => response.body?.cancel())
          .catch(() => {});
      }
      onClose();
    },
  };
}
