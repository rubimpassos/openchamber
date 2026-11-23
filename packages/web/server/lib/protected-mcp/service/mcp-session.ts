import { isPlainObject, isRecord, isString } from '../../shared/guards.js';
import { MAX_FRAME_BYTES } from './contract.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import type { ConnectionId } from './contract.js';
import type { StoredDefinition, ToolPolicy } from './definition-types.js';
import type { EngineSocketSessions, EngineSocketStore } from './engine-socket.js';
import type { Subject } from './subject-contract.js';

export type McpBackend = {
  readonly send: (message: JsonObject) => void;
  readonly onMessage: (callback: (message: JsonValue) => void) => void;
  readonly onClose: (callback: () => void) => void;
  readonly close: () => void;
};
export type SessionManager = EngineSocketSessions & {
  readonly endConnection: (id: ConnectionId, reason?: string) => void;
  readonly restrictSubject: (subject: Subject, allowed: readonly ConnectionId[]) => void;
  readonly closeAll: () => void;
  readonly count: (id: ConnectionId) => number;
};
type Session = { readonly id: ConnectionId; readonly subject: Subject | null; closed: boolean; end: (reason?: string) => void };
type SessionOptions = {
  readonly store: Pick<EngineSocketStore, 'get'>;
  readonly startBackend: (definition: StoredDefinition) => McpBackend | Promise<McpBackend>;
  readonly version: string;
  readonly log?: (event: string, fields: { readonly connection: ConnectionId; readonly code: unknown }) => void;
};
type Request = JsonObject & { readonly method: string };
const fields = (value: JsonValue | undefined): JsonObject => isPlainObject(value) ? value : {};

const FALLBACK_TOOL = 'authorization_required';
const DEFAULT_PROTOCOL = '2025-06-18';

const toolMatches = (patterns: readonly string[], name: string) => patterns.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));

function toolAllowed(policy: ToolPolicy, name: JsonValue | undefined) {
  if (!isString(name)) return false;
  if (policy.allowTools && !toolMatches(policy.allowTools, name)) return false;
  return !(policy.denyTools && toolMatches(policy.denyTools, name));
}

const isRequest = (message: JsonValue | undefined): message is Request => isPlainObject(message) && isString(message.method) && message.id !== undefined && message.id !== null;
const isResponse = (message: JsonValue): message is JsonObject => isPlainObject(message) && message.method === undefined && message.id !== undefined;

export function unavailableMessage({ name, reason }: { readonly name: string; readonly reason: string }) {
  switch (reason) {
    case 'missing':
      return `The protected MCP connection "${name}" has no stored credential. Ask the administrator to add it in OpenChamber: Settings → MCP → ${name}.`;
    case 'authorization_required':
      return `The protected MCP connection "${name}" needs authorization. Ask the administrator to sign in to it in OpenChamber: Settings → MCP → ${name}.`;
    case 'runtime_installing':
      return `The MCP server of the protected connection "${name}" is still being installed. Reconnect it in a minute.`;
    default:
      return `The MCP server of the protected connection "${name}" could not start (${reason}). Ask the administrator to check it in OpenChamber: Settings → MCP → ${name}.`;
  }
}

export function createFallbackBackend({ message, version }: { readonly message: string; readonly version: string }): McpBackend {
  let onMessage: (message: JsonValue) => void = () => {};
  let onClose = () => {};
  const reply = (id: JsonValue | undefined, result: JsonValue) => queueMicrotask(() => onMessage({ jsonrpc: '2.0', id, result }));
  return {
    send(message_) {
      if (!isRequest(message_)) return;
      switch (message_.method) {
        case 'initialize':
          return reply(message_.id, {
            protocolVersion: isString(fields(message_.params).protocolVersion) ? fields(message_.params).protocolVersion : DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'openchamber-protected-mcp', version },
            instructions: message,
          });
        case 'ping':
          return reply(message_.id, {});
        case 'tools/list':
          return reply(message_.id, {
            tools: [{ name: FALLBACK_TOOL, description: message, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
          });
        case 'tools/call':
          return reply(message_.id, { content: [{ type: 'text', text: message }], isError: true });
        default:
          return queueMicrotask(() => onMessage({ jsonrpc: '2.0', id: message_.id, error: { code: -32601, message: 'Method not found' } }));
      }
    },
    onMessage(callback) { onMessage = callback; },
    onClose(callback) { onClose = callback; },
    close() { onClose(); },
  };
}

export function createLineReader({ onValue, onInvalid = () => {}, onOverflow = () => {} }: {
  readonly onValue: (value: JsonValue) => void;
  readonly onInvalid?: () => void;
  readonly onOverflow?: () => void;
}) {
  let buffer: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    let index;
    while ((index = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, index).toString('utf8').trim();
      buffer = buffer.subarray(index + 1);
      if (!line) continue;
      let value: JsonValue;
      try {
        value = JSON.parse(line);
      } catch {
        onInvalid();
        continue;
      }
      onValue(value);
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = Buffer.alloc(0);
      onOverflow();
    }
  };
}

export function createSessionManager({ store, startBackend, version, log = () => {} }: SessionOptions): SessionManager {
  const sessions = new Map<ConnectionId, Set<Session>>();

  const open: EngineSocketSessions['open'] = (definition, socket, { initial, subject }) => {
    const pending = new Map<JsonValue | undefined, string>();
    const session: Session = { id: definition.id, subject, closed: false, end: () => {} };
    const group = sessions.get(definition.id) ?? new Set();
    group.add(session);
    sessions.set(definition.id, group);
    let backend: McpBackend | null = null;
    const queued: JsonObject[] = [];

    const write = (message: JsonValue) => {
      if (session.closed) return;
      if (socket.writableLength > MAX_FRAME_BYTES * 2) {
        session.end('client_not_reading');
        return;
      }
      socket.write(`${JSON.stringify(message)}\n`);
    };

    const declared = new Map<JsonValue | undefined, Set<string>>();
    const fromBackend = (message: JsonValue): void => {
      if (Array.isArray(message)) return message.forEach(fromBackend);
      if (isResponse(message)) {
        const method = pending.get(message.id);
        pending.delete(message.id);
        if (method === 'tools/list' && isPlainObject(message.result) && Array.isArray(message.result.tools)) {
          const policy = store.get(definition.id)?.policy ?? {};
          for (const tool of message.result.tools) {
            const entry = fields(tool);
            const properties = fields(entry.inputSchema).properties;
            if (isString(entry.name) && isPlainObject(properties)) declared.set(entry.name, new Set(Object.keys(properties)));
          }
          return write({ ...message, result: { ...message.result, tools: message.result.tools.filter((tool) => toolAllowed(policy, fields(tool).name)) } });
        }
      }
      return write(message);
    };

    const withDefaults = (message: Request, policy: ToolPolicy): Request => {
      const defaults = policy.defaultArguments;
      const params = fields(message.params);
      const names = declared.get(params.name);
      if (!defaults || !names) return message;
      const given = fields(params.arguments);
      const filled = { ...given };
      for (const [name, value] of Object.entries(defaults)) {
        if (names.has(name) && !Object.hasOwn(given, name)) filled[name] = value;
      }
      return { ...message, params: { ...params, arguments: filled } };
    };

    const fromClient = (incoming: JsonValue): void => {
      if (session.closed) return undefined;
      if (Array.isArray(incoming)) return incoming.forEach(fromClient);
      if (!isPlainObject(incoming)) return undefined;
      let message = incoming;
      if (isRequest(message)) {
        const method = message.method;
        if (message.method === 'tools/call') {
          const policy = store.get(definition.id)?.policy ?? {};
          if (!toolAllowed(policy, fields(message.params).name)) {
            return write({
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: 'The administrator does not allow this tool on this connection.' }], isError: true },
            });
          }
          message = withDefaults(message, policy);
        }
        pending.set(message.id, method);
      }
      if (!backend) {
        queued.push(message);
        return undefined;
      }
      return backend.send(message);
    };

    session.end = (reason) => {
      if (session.closed) return;
      if (reason === 'connection_changed') {
        write({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'warning', logger: 'openchamber-protected-mcp', data: 'The administrator changed this protected connection. Reconnect it to continue.' } });
      }
      session.closed = true;
      group.delete(session);
      backend?.close();
      socket.end();
      setTimeout(() => socket.destroy(), 2000).unref();
    };

    const read = createLineReader({
      onValue: fromClient,
      onInvalid: () => write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      onOverflow: () => session.end('frame_too_large'),
    });
    socket.on('data', read);
    socket.on('end', () => session.end('client_closed'));
    socket.on('close', () => session.end('client_closed'));
    socket.on('error', () => session.end('client_error'));
    if (initial.length > 0) read(initial);

    Promise.resolve(startBackend(definition))
      .catch((error) => {
        const failure: unknown = error;
        const code = isRecord(failure) ? failure.code : undefined;
        log('backend_start_failed', { connection: definition.id, code: code ?? 'unknown' });
        return createFallbackBackend({
          message: unavailableMessage({ name: definition.name, reason: String(code ?? 'start_failed') }),
          version,
        });
      })
      .then((started) => {
        if (session.closed) {
          started.close();
          return;
        }
        backend = started;
        backend.onMessage(fromBackend);
        backend.onClose(() => session.end('backend_closed'));
        for (const message of queued.splice(0)) backend.send(message);
      });
  };

  return {
    open,
    endConnection(id, reason = 'connection_changed') {
      for (const session of [...(sessions.get(id) ?? [])]) session.end(reason);
    },
    restrictSubject(subject, allowed) {
      for (const [id, group] of sessions) {
        if (allowed.includes(id)) continue;
        for (const session of [...group]) if (session.subject === subject) session.end('subject_changed');
      }
    },
    closeAll() {
      for (const group of sessions.values()) for (const session of [...group]) session.end('service_closing');
    },
    count: (id) => sessions.get(id)?.size ?? 0,
    countAll: () => [...sessions.values()].reduce((count, group) => count + group.size, 0),
  };
}
