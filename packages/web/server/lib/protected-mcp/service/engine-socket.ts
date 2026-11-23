import fs from 'node:fs/promises';
import net from 'node:net';
import { assertNever, MAX_FRAME_BYTES, parseEngineFrame } from './contract.js';
import type { ConnectionId, toPublicStatus } from './contract.js';
import type { StoredDefinition } from './definition-types.js';
import type { Subject } from './subject-contract.js';

export type EngineSocketStore = {
  readonly get: (id: ConnectionId) => StoredDefinition | undefined;
  readonly subjectAllows: (subject: Subject, id: ConnectionId) => boolean;
};
export type EngineSocketSessions = {
  readonly countAll: () => number;
  readonly open: (definition: StoredDefinition, socket: net.Socket, context: { readonly initial: Buffer; readonly subject: Subject | null }) => void;
};
export type EngineSocketLog = (event: string, fields: { readonly code: string }) => void;
export type EngineSocketServer = {
  readonly listen: () => Promise<void>;
  readonly close: () => Promise<void>;
};
export type EngineSocketOptions = {
  readonly path: string;
  readonly group?: number | null;
  readonly store: EngineSocketStore;
  readonly sessions: EngineSocketSessions;
  readonly log?: EngineSocketLog | undefined;
} & (
  | { readonly subject?: null; readonly status: () => ReturnType<typeof toPublicStatus> }
  | { readonly subject: Subject; readonly status?: never }
);

const HELLO_TIMEOUT_MS = 5000;
const MAX_SESSIONS = 64;
const CLOSE_GRACE_MS = 2000;

const probeSocket = (path: string) => new Promise<boolean>((resolve) => {
  const socket = net.createConnection(path);
  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('error', () => resolve(false));
});

async function clearStaleSocket(path: string): Promise<void> {
  let stats;
  try {
    stats = await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isSocket()) throw new Error('engine socket path is occupied by something else');
  if (await probeSocket(path)) throw new Error('another protected MCP service is listening');
  await fs.unlink(path);
}

export function createEngineSocketServer(options: EngineSocketOptions): EngineSocketServer {
  const { path, group = null, subject = null, store, sessions, log = () => {} } = options;
  const readStatus = options.subject == null ? options.status : null;
  const sockets = new Set<net.Socket>();
  const inSession = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      inSession.delete(socket);
    });
    let buffer = Buffer.alloc(0);
    let decided = false;
    const timer = setTimeout(() => answerError('hello_timeout'), HELLO_TIMEOUT_MS);
    const answer = (value: ReturnType<typeof toPublicStatus> | { readonly type: 'error'; readonly code: string }) => {
      clearTimeout(timer);
      decided = true;
      socket.off('data', onData);
      socket.end(`${JSON.stringify(value)}\n`);
      setTimeout(() => socket.destroy(), 2000).unref();
    };
    const answerError = (code: string) => {
      if (!decided) answer({ type: 'error', code });
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0x0a);
      if (end === -1) {
        if (buffer.length > MAX_FRAME_BYTES) answerError('malformed_frame');
        return;
      }
      const parsed = parseEngineFrame(buffer.subarray(0, end).toString('utf8'));
      const rest = buffer.subarray(end + 1);
      if (!parsed.ok) return answerError(parsed.code);
      switch (parsed.frame.type) {
        case 'status':
          return readStatus === null ? answerError('unsupported_request') : answer(readStatus());
        case 'hello':
          break;
        default:
          return assertNever(parsed.frame);
      }
      if (subject !== null && !store.subjectAllows(subject, parsed.frame.connection)) return answerError('connection_not_allowed');
      const definition = store.get(parsed.frame.connection);
      if (!definition) return answerError('unknown_connection');
      if (!definition.enabled) return answerError('connection_disabled');
      if (sessions.countAll() >= MAX_SESSIONS) return answerError('too_many_sessions');
      clearTimeout(timer);
      decided = true;
      socket.off('data', onData);
      inSession.add(socket);
      socket.write(`${JSON.stringify({ type: 'ready', connection: definition.id, name: definition.name })}\n`);
      sessions.open(definition, socket, { initial: rest, subject });
      return undefined;
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
    socket.on('end', () => {
      if (!decided) answerError('malformed_frame');
    });
  });
  server.on('error', (error: NodeJS.ErrnoException) => log('engine_socket_error', { code: error.code ?? 'unknown' }));

  return {
    async listen() {
      await clearStaleSocket(path);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (group !== null) await fs.chown(path, -1, group);
      await fs.chmod(path, subject === null ? 0o660 : 0o666);
    },
    close: () => new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, CLOSE_GRACE_MS);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      for (const socket of sockets) if (!inSession.has(socket)) socket.destroy();
    }),
  };
}
