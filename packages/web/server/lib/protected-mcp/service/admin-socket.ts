import fs from 'node:fs/promises';
import net from 'node:net';
import { hasProperties, isNumber, isPlainObject, isString } from '../../shared/guards.js';
import type { JsonObject } from '../../shared/json-values.js';
import { isConnectionId, ProtectedMcpError } from './contract.js';
import type { ConnectionId, toPublicStatus } from './contract.js';
import type { StoredDefinition } from './definition-types.js';
import { parseOperation } from './store.js';
import type { openStore } from './store.js';
import { parseSubject, parseSubjectConnections } from './subject-contract.js';
import type { createSubjectListeners } from './subject-listeners.js';
import type { createRuntimes } from './runtimes.js';

type Store = Awaited<ReturnType<typeof openStore>>;
type AdminView = ReturnType<Store['adminViews']>[number] & { readonly runtime?: Awaited<ReturnType<ReturnType<typeof createRuntimes>['status']>> };
type RemovedCredentials = NonNullable<Awaited<ReturnType<Store['apply']>>['removedCredentials']>;
export type AdminOAuth = {
  readonly start: (input: { readonly id: ConnectionId; readonly expectedRevision: number; readonly redirectUri: string }) => Promise<{ readonly attempt: string; readonly url: string }>;
  readonly complete: (input: { readonly state: string; readonly code: string | undefined; readonly error: string | undefined }) => Promise<{ readonly outcome: string; readonly name: string | null }>;
  readonly attempt: (id: string) => { readonly status: 'unknown' | 'pending' } | { readonly status: 'done'; readonly outcome: string };
  readonly revokeUpstream: (definition: StoredDefinition, credentials: RemovedCredentials['credentials']) => Promise<void>;
};
export type AdminSocketOptions = {
  readonly path: string;
  readonly group?: number | null;
  readonly store: Pick<Store, 'subjects' | 'get' | 'apply'>;
  readonly status: () => ReturnType<typeof toPublicStatus>;
  readonly views: () => Promise<readonly AdminView[]> | readonly AdminView[];
  readonly oauth: AdminOAuth;
  readonly subjectListeners: Pick<ReturnType<typeof createSubjectListeners>, 'set' | 'remove'>;
  readonly log?: (event: string, fields: { readonly connection: ConnectionId | undefined; readonly kind?: string } | { readonly name: unknown } | { readonly code: string }) => void;
  readonly requestTimeoutMs?: number;
};
type AdminAnswer =
  | { readonly type: 'subjects'; readonly subjects: ReturnType<Store['subjects']> }
  | ({ readonly type: 'subject' } & Awaited<ReturnType<ReturnType<typeof createSubjectListeners>['set']>>)
  | { readonly type: 'subject-removed'; readonly subject: ReturnType<typeof parseSubject> }
  | { readonly type: 'connections'; readonly status: ReturnType<typeof toPublicStatus>; readonly connections: readonly AdminView[] }
  | { readonly type: 'connection' | 'applied'; readonly connection: AdminView | null }
  | { readonly type: 'oauth-started'; readonly attempt: string; readonly authorizationUrl: string }
  | ({ readonly type: 'oauth-completed' } & Awaited<ReturnType<AdminOAuth['complete']>>)
  | ({ readonly type: 'oauth-attempt' } & ReturnType<AdminOAuth['attempt']>)
  | { readonly type: 'error'; readonly code: string; readonly status: number; readonly message: string };

const MAX_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 2000;
const ATTEMPT = /^[A-Za-z0-9_-]{22}$/;
function invalid(): never { throw new ProtectedMcpError('invalid_request'); }
const text = (value: unknown, max: number): value is string => isString(value) && value.length <= max;

async function clearStaleSocket(path: string): Promise<void> {
  const stats = await fs.lstat(path).catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return;
  if (!stats.isSocket()) throw new Error('admin socket path is occupied');
  const listening = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(path);
    probe.setTimeout(CLOSE_GRACE_MS, () => { probe.destroy(); resolve(true); });
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  if (listening) throw new Error('another protected MCP administrator socket is listening');
  await fs.unlink(path);
}

export function createAdminSocketServer({ path, group = null, store, status, views, oauth, subjectListeners, log = () => {}, requestTimeoutMs = 5000 }: AdminSocketOptions) {
  const sockets = new Set<net.Socket>();
  const requests = new Set<Promise<void>>();
  let closing = false;
  const view = async (id: ConnectionId) => (await views()).find((connection) => connection.id === id) ?? null;
  const dispatch = async (frame: JsonObject): Promise<AdminAnswer> => {
    if (!isString(frame.type)) invalid();
    switch (frame.type) {
      case 'subjects':
        return { type: 'subjects', subjects: store.subjects() };
      case 'subject-set': {
        const subject = parseSubject(frame.subject);
        const connections = parseSubjectConnections(frame.connections);
        if (connections.some((id) => !store.get(id))) throw new ProtectedMcpError('unknown_connection', { status: 404 });
        return { type: 'subject', ...await subjectListeners.set(subject, connections) };
      }
      case 'subject-remove': {
        const subject = parseSubject(frame.subject);
        await subjectListeners.remove(subject);
        return { type: 'subject-removed', subject };
      }
      case 'list':
        return { type: 'connections', status: status(), connections: await views() };
      case 'get': {
        if (!isConnectionId(frame.id)) invalid();
        const connection = await view(frame.id);
        if (!connection) throw new ProtectedMcpError('connection_not_found', { status: 404 });
        return { type: 'connection', connection };
      }
      case 'apply': {
        const operation = parseOperation(frame.operation);
        const { connection: changed, removedCredentials } = await store.apply(operation);
        if (removedCredentials?.credentials?.oauth) {
          const { definition, credentials } = removedCredentials;
          const work = oauth.revokeUpstream(definition, credentials).catch(() => log('oauth_revocation_failed', { connection: definition.id }));
          requests.add(work);
          work.finally(() => requests.delete(work));
        }
        log('connection_changed', { kind: operation.kind, connection: changed?.id ?? ('id' in operation ? operation.id : undefined) });
        return { type: 'applied', connection: changed ? await view(changed.id) : null };
      }
      case 'oauth-start': {
        if (!isConnectionId(frame.id) || !isNumber(frame.expectedRevision) || !Number.isSafeInteger(frame.expectedRevision) || !text(frame.redirectUri, 2048)) invalid();
        const { attempt, url } = await oauth.start({ id: frame.id, expectedRevision: frame.expectedRevision, redirectUri: frame.redirectUri });
        return { type: 'oauth-started', attempt, authorizationUrl: url };
      }
      case 'oauth-complete': {
        if (!text(frame.state, 4096) || (frame.code !== undefined && !text(frame.code, 4096)) || (frame.error !== undefined && !text(frame.error, 4096))) invalid();
        return { type: 'oauth-completed', ...await oauth.complete({ state: frame.state, code: frame.code, error: frame.error }) };
      }
      case 'oauth-attempt':
        if (!isString(frame.attempt) || !ATTEMPT.test(frame.attempt)) invalid();
        return { type: 'oauth-attempt', ...oauth.attempt(frame.attempt) };
      default:
        throw new ProtectedMcpError('unsupported_request');
    }
  };
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const full = sockets.size >= 16;
    sockets.add(socket);
    let decided = false;
    let buffer: Buffer = Buffer.alloc(0);
    let destroyTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => refuse(new ProtectedMcpError('request_timeout')), requestTimeoutMs);
    const answer = (frame: AdminAnswer) => {
      clearTimeout(timer);
      decided = true;
      socket.off('data', onData);
      if (!socket.destroyed && !socket.writableEnded) socket.end(`${JSON.stringify(frame)}\n`);
      destroyTimer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
      destroyTimer.unref();
    };
    const refuse = (cause: unknown) => {
      if (cause instanceof ProtectedMcpError) answer({ type: 'error', code: cause.code, status: cause.status, message: cause.message });
      else {
        log('admin_request_failed', { name: hasProperties(cause) ? cause.name ?? 'Error' : 'Error' });
        answer({ type: 'error', code: 'internal_error', status: 500, message: 'internal_error' });
      }
    };
    const onData = (chunk: Buffer) => {
      if (decided || closing) return;
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      if (buffer.length + part.length > MAX_BYTES) return refuse(new ProtectedMcpError('frame_too_large'));
      buffer = Buffer.concat([buffer, part]);
      if (newline === -1) return;
      decided = true;
      clearTimeout(timer);
      socket.off('data', onData);
      let frame: JsonObject;
      try {
        frame = JSON.parse(buffer.toString('utf8'));
        if (!isPlainObject(frame)) throw new Error('not an object');
      } catch {
        return refuse(new ProtectedMcpError('malformed_frame'));
      }
      buffer = Buffer.alloc(0);
      const work = dispatch(frame).then(answer, refuse);
      requests.add(work);
      work.finally(() => requests.delete(work));
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
    socket.once('end', () => { if (!decided) refuse(new ProtectedMcpError('malformed_frame')); });
    socket.once('close', () => {
      clearTimeout(timer);
      clearTimeout(destroyTimer);
      socket.off('data', onData);
      sockets.delete(socket);
    });
    if (full) refuse(new ProtectedMcpError('too_many_requests', { status: 503 }));
  });
  server.on('error', (error: NodeJS.ErrnoException) => log('admin_socket_error', { code: error.code ?? 'unknown' }));
  return {
    async listen() {
      await clearStaleSocket(path);
      closing = false;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => { server.off('error', reject); resolve(); });
      });
      await fs.chmod(path, 0o660);
      if (group !== null) await fs.chown(path, -1, group);
    },
    async close() {
      closing = true;
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, CLOSE_GRACE_MS);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.end();
      });
      clearTimeout(timer);
      while (requests.size > 0) await Promise.allSettled(requests);
    },
  };
}
