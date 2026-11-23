import WebSocket from 'ws';
import { z } from 'zod';
import { createCredentialResolver } from './services/credentials.js';
import { createProviderHttp } from './services/http.js';
import type { ProviderHttp, ProviderHttpOptions, ProviderRequest } from './services/http.js';
import type { createBotIdentityStore } from './identities.js';
import type { RawData, WebSocket as GatewaySocket } from '../shared/websocket-contracts.js';
import type { BotServiceInput, BotServiceReply } from '../agent-server/bot-service-contract.js';
import { botBoundaryError, botDiscordFrameSchema, botGatewayUrlSchema, botGatewayMessageSchema, botGatewayReadySchema } from '../agent-server/bot-service-contract.js';

type GatewayScope = BotServiceInput<'gateway-close'>['scope'];
type ConnectionKey = {
  readonly connectionId: BotServiceInput<'gateway-close'>['connectionId'];
  readonly scope: { readonly project: Pick<GatewayScope['project'], 'id' | 'path'>;
    readonly bot: Pick<GatewayScope['bot'], 'id'>; readonly item: Pick<GatewayScope['item'], 'id'> };
};
type GatewayCredential = {
  readonly authority: { readonly providerAccountId: string };
  readonly definition: { readonly applicationId: string; readonly botToken: string };
  readonly assertCurrent: () => Promise<void>;
  readonly request: (input: ProviderRequest) => ReturnType<ProviderHttp>;
};
type ResolveCredential = (input: Pick<BotServiceInput<'gateway-open'>, 'identityId' | 'identityRevision'> & {
  readonly service: 'discord'; readonly target: { readonly guildId: 'dm'; readonly channelId: '000000' };
}) => Promise<GatewayCredential>;
type Socket = Pick<GatewaySocket, 'send' | 'terminate'> & {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: RawData) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
};
type GatewayOptions = Pick<ProviderHttpOptions, 'fetchImpl' | 'policyOptions'> & {
  readonly createSocket?: (url: string, options: {
    readonly followRedirects: false; readonly maxPayload: number; readonly handshakeTimeout: number;
  }) => Socket;
} & (
  | { readonly identities: ReturnType<typeof createBotIdentityStore>; readonly resolveCredential?: ResolveCredential }
  | { readonly identities?: ReturnType<typeof createBotIdentityStore>; readonly resolveCredential: ResolveCredential }
);
type PullOptions = { readonly signal?: AbortSignal | undefined };
type Connection = {
  readonly owner: ReturnType<typeof identityOf>;
  readonly identityId: string;
  readonly identityRevision: number;
  readonly credential: GatewayCredential;
  readonly botUserId: string;
  readonly applicationId: string;
  readonly socket: Socket;
  state: BotServiceReply<'gateway-pull'>['state'];
  frames: BotServiceReply<'gateway-pull'>['frames'];
  sequence: number;
  acknowledged: number;
  closeCode: number | null;
  errorCode?: string;
  readonly waiters: Set<() => void>;
};
const envelopeSchema = z.object({ op: z.unknown(), s: z.unknown(), t: z.unknown(), d: z.unknown() });
const identityOf = (input: Pick<ConnectionKey, 'scope'>) => ({ projectId: input.scope.project.id, projectPath: input.scope.project.path,
  botId: input.scope.bot.id, itemId: input.scope.item.id });
const canonicalUrl = (value: string) => { const url = new URL(botGatewayUrlSchema.parse(value)); url.search = '?v=10&encoding=json'; return url.href; };

export function createBotAgentGatewayTransport({ identities, fetchImpl, policyOptions, resolveCredential,
  createSocket = (url, options) => new WebSocket(url, options) }: GatewayOptions) {
  let resolve: ResolveCredential;
  if (resolveCredential) resolve = resolveCredential;
  else {
    if (!identities) throw new TypeError('Discord transport requires an identity store');
    resolve = createCredentialResolver({ identities, http: createProviderHttp({ fetchImpl, policyOptions }), jiraOAuthHttp: undefined });
  }
  const connections = new Map<string, Connection>();
  let stopped = false;
  const fail = (): never => { throw botBoundaryError('BOT_DISCORD_GATEWAY_CHANGED', 409); };
  const find = (input: ConnectionKey): Connection => {
    const connection = connections.get(input.connectionId);
    if (!connection) return fail();
    if (JSON.stringify(connection.owner) !== JSON.stringify(identityOf(input))) fail();
    return connection;
  };
  const notify = (connection: Connection) => { for (const wake of connection.waiters) wake(); connection.waiters.clear(); };
  const open = async (input: BotServiceInput<'gateway-open'>, { signal }: PullOptions = {}): Promise<BotServiceReply<'gateway-open'>> => {
    signal?.throwIfAborted();
    if (stopped) throw botBoundaryError('BOT_EXECUTION_STOPPED', 503);
    if (input.scope.bot.identity.discord?.identityId !== input.identityId) fail();
    if (connections.has(input.connectionId)) {
      const existing = find(input);
      if (existing.identityId !== input.identityId || existing.identityRevision !== input.identityRevision) fail();
      return { connectionId: input.connectionId, botUserId: existing.botUserId, applicationId: existing.applicationId };
    }
    if (connections.size >= 100) throw botBoundaryError('BOT_DISCORD_GATEWAY_LIMIT', 409);
    const credential = await resolve({ identityId: input.identityId, identityRevision: input.identityRevision,
      service: 'discord', target: { guildId: 'dm', channelId: '000000' } });
    const gateway = z.object({ url: botGatewayUrlSchema, session_start_limit: z.object({ remaining: z.number().int().nonnegative() }) })
      .parse(await credential.request({ path: '/api/v10/gateway/bot' }));
    if (!input.cursor && gateway.session_start_limit.remaining === 0) throw botBoundaryError('BOT_DISCORD_SESSION_LIMIT', 409);
    signal?.throwIfAborted();
    if (stopped) throw botBoundaryError('BOT_EXECUTION_STOPPED', 503);
    if (connections.has(input.connectionId)) return open(input, { signal });
    const socket = createSocket(canonicalUrl(input.cursor?.resumeUrl ?? gateway.url),
      { followRedirects: false, maxPayload: 128 * 1024, handshakeTimeout: 15_000 });
    const connection: Connection = { owner: identityOf(input), identityId: input.identityId, identityRevision: input.identityRevision, credential,
      botUserId: credential.authority.providerAccountId, applicationId: credential.definition.applicationId,
      socket, state: 'connecting', frames: [], sequence: 0, acknowledged: 0, closeCode: null, waiters: new Set() };
    connections.set(input.connectionId, connection);
    socket.on('open', () => { connection.state = 'open'; notify(connection); });
    socket.on('message', (bytes) => {
      try {
        if (Array.isArray(bytes)) throw botBoundaryError('BOT_DISCORD_GATEWAY_INVALID_FRAME');
        if (Buffer.byteLength(bytes) > 128 * 1024) throw botBoundaryError('BOT_DISCORD_FRAME_TOO_LARGE');
        const raw = envelopeSchema.parse(JSON.parse(String(bytes)));
        const data = raw.op === 0 ? raw.t === 'READY' ? botGatewayReadySchema.parse(raw.d)
          : raw.t === 'MESSAGE_CREATE' ? botGatewayMessageSchema.parse(raw.d) : null : raw.d;
        const frame = botDiscordFrameSchema.parse({ op: raw.op, s: raw.s, t: raw.t, d: data });
        if (connection.frames.length >= 128) throw botBoundaryError('BOT_DISCORD_GATEWAY_BACKLOG_LIMIT');
        connection.frames.push({ id: ++connection.sequence, frame }); notify(connection);
      } catch (error) {
        connection.errorCode = error instanceof Error && 'code' in error && error.code === 'BOT_DISCORD_FRAME_TOO_LARGE'
          ? error.code : 'BOT_DISCORD_GATEWAY_INVALID_FRAME';
        socket.terminate(); notify(connection);
      }
    });
    socket.on('error', (error) => {
      connection.errorCode = 'code' in error && error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'BOT_DISCORD_FRAME_TOO_LARGE' : 'BOT_DISCORD_GATEWAY_FAILED';
      socket.terminate(); notify(connection);
    });
    socket.on('close', (code) => { connection.state = 'closed'; connection.closeCode = code; notify(connection); });
    return { connectionId: input.connectionId, botUserId: connection.botUserId, applicationId: connection.applicationId };
  };
  const pull = async (input: BotServiceInput<'gateway-pull'>, { signal }: PullOptions = {}): Promise<BotServiceReply<'gateway-pull'>> => {
    const connection = find(input);
    const observed = input.observed ?? input.after;
    if (input.after < connection.acknowledged || observed < input.after || observed > connection.sequence) fail();
    connection.acknowledged = input.after;
    connection.frames = connection.frames.filter((entry) => entry.id > input.after);
    if (!connection.frames.some((entry) => entry.id > observed) && connection.state !== 'closed') {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener('abort', abort); connection.waiters.delete(wake); resolve(); };
        const abort = () => { connection.waiters.delete(wake); reject(signal?.reason); };
        connection.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    const result: BotServiceReply<'gateway-pull'> = { connectionId: input.connectionId, frames: connection.frames.filter((entry) => entry.id > observed).slice(0, 16), state: connection.state,
      closeCode: connection.closeCode };
    if (connection.errorCode) result.errorCode = connection.errorCode;
    return result;
  };
  const send = async (input: BotServiceInput<'gateway-send'>): Promise<BotServiceReply<'gateway-send'>> => {
    const connection = find(input);
    await connection.credential.assertCurrent();
    if (connection.state !== 'open') throw botBoundaryError('BOT_DISCORD_GATEWAY_CLOSED', 409);
    const token = connection.credential.definition.botToken;
    const { frame } = input;
    let value;
    switch (frame.kind) {
      case 'heartbeat': value = { op: 1, d: frame.sequence }; break;
      case 'resume': value = { op: 6, d: { token, session_id: frame.sessionId, seq: frame.sequence } }; break;
      case 'identify': value = { op: 2, d: { token, intents: 512 | 4096,
        properties: { os: process.platform, browser: 'OpenChamber', device: 'OpenChamber' } } }; break;
      default: { frame satisfies never; throw botBoundaryError('BOT_DISCORD_GATEWAY_CHANGED', 409); }
    }
    await new Promise<void>((resolveSend, reject) => connection.socket.send(JSON.stringify(value), (error) => error ? reject(error) : resolveSend()));
    return { ok: true };
  };
  const close = (input: ConnectionKey): BotServiceReply<'gateway-close'> => {
    if (!connections.has(input.connectionId)) return { ok: true };
    const connection = find(input); connections.delete(input.connectionId);
    connection.state = 'closed'; connection.socket.terminate(); notify(connection);
    return { ok: true };
  };
  return { open, pull, send, close, stop() { stopped = true; for (const [connectionId, connection] of connections) close({ connectionId,
    scope: { project: { id: connection.owner.projectId, path: connection.owner.projectPath }, bot: { id: connection.owner.botId }, item: { id: connection.owner.itemId } } }); } };
}
