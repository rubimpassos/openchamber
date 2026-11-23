import path from 'node:path';
import { z } from 'zod';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { BotServiceError } from './services/contracts.js';
import { TERMINAL_ITEM_STATES } from './schema.js';
import { isJsonObject, isString } from '../event-stream/guards.js';
import type { BotItem } from './schema.js';
import type { BotDefinition } from './config.js';
import type { createBotPlacement } from './placement.js';
import type { BotServiceReply } from '../agent-server/bot-service-contract.js';
import type { MessageQueueOptions } from '../message-queue/runtime.js';
import type { GlobalStreamEvent } from '../event-stream/global-hub.js';
import type { JsonObject } from '../event-stream/contracts.js';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';
import type { SessionActivityProbe } from '../opencode/session-activity.js';
import type { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import type { KnowledgeCollector, KnowledgeSyncOptions } from '../session-knowledge/contracts.js';
import type { JsonValue } from '../shared/json-values.js';

type SessionEntry = {
  readonly projectId: string; readonly itemId: string; readonly botId: string;
  readonly sessionId: string; readonly stage: keyof BotItem['sessions'];
  readonly directory: string; readonly isolated: boolean;
};
type QueueTarget = Omit<SessionEntry, 'botId'>;
type Queue = ReturnType<typeof createMessageQueueRuntime>;
type TokenReader = ReturnType<typeof createTokenSnapshotReader>;
type TokenOptions = Parameters<TokenReader>[2];
type Notice = Parameters<NonNullable<MessageQueueOptions['botTransport']>['deliverNotice']>[0];
type SessionInfo = z.output<typeof sessionInfoSchema>;
type IsolatedOwner = {
  readonly binding: { readonly projectId: string; readonly itemId: string; readonly botId: string;
    readonly hostDirectory: string; readonly directory: string; readonly spaceId: string };
  readonly info: SessionInfo;
  readonly fetchImpl: NonNullable<MessageQueueOptions['fetchImpl']>;
  readonly tokens: TokenReader;
  readonly probe: Pick<SessionActivityProbe, 'fetchActiveSessionStatuses' | 'hasWorkingDescendants'>;
  readonly client: { readonly session: { readonly instructions: { readonly entry: {
    put(input: { readonly sessionID: string; readonly key: string; readonly value: string }): Promise<void>;
  } } } };
};
type HostExecution = {
  readSession(entry: SessionEntry): Promise<BotServiceReply<'session'>>;
  isWorking(entry: SessionEntry): Promise<boolean | null>;
  readTokens(entry: SessionEntry, options?: TokenOptions): Promise<number | null>;
  syncKnowledge(entry: SessionEntry, options?: KnowledgeSyncOptions): Promise<BotServiceReply<'knowledge-sync'> | void>;
  deliverNotice(entry: SessionEntry & Notice): Promise<BotServiceReply<'synthetic-deliver'> | void>;
};
type HostSessionsOptions = {
  readonly dataDir: string;
  readonly isolated: { sessionOwner(input: { readonly sessionId: string }): Promise<IsolatedOwner> };
  readonly clientFor: (directory: string) => { readonly session: { get(input: { readonly sessionID: string }): Promise<JsonValue | undefined> } };
  readonly hostQueue: Queue | null;
  readonly readHostTokens: TokenReader | null;
  readonly assertDispatch: NonNullable<MessageQueueOptions['assertBotDispatch']>;
  readonly broadcast: NonNullable<MessageQueueOptions['broadcastGlobalUiEvent']>;
  readonly sessionKnowledgeRuntime: KnowledgeCollector;
  readonly isSessionArchived: (sessionId: string) => Promise<boolean>;
  readonly resolvePlacement: ReturnType<typeof createBotPlacement>['resolve'];
  readonly hostExecution?: HostExecution | null | undefined;
};
type QueueEntry = { readonly queue: Queue; readonly listeners: Set<(event: GlobalStreamEvent) => void>;
  readonly spaceId: string | null; release?: () => void };
const sessionInfoSchema = z.object({ id: z.string(), location: z.object({ directory: z.string().optional() }).nullish(),
  time: z.object({ archived: z.unknown().optional() }).nullish(), metadata: z.unknown().optional() });
const refuse: () => never = () => { throw new BotServiceError('BOT_ISOLATED_SESSION_MISMATCH', 'The recorded bot session runtime is unavailable.'); };

export function createBotHostSessions({ dataDir, isolated, clientFor, hostQueue,
  readHostTokens, assertDispatch, broadcast, sessionKnowledgeRuntime, isSessionArchived, resolvePlacement, hostExecution = null }: HostSessionsOptions) {
  const sessions = new Map<string, SessionEntry>();
  const queues = new Map<string, QueueEntry>();
  const transfers = new Set<Promise<unknown>>();
  const trackTransfer = <T>(transfer: Promise<T>): Promise<T> => {
    transfers.add(transfer);
    void transfer.then(() => transfers.delete(transfer), () => transfers.delete(transfer));
    return transfer;
  };
  let started = false;
  let stopped = false;
  const track = (request: SessionEntry) => sessions.set(request.sessionId, request);
  const trackItem = async (projectId: string, item: BotItem, bot: BotDefinition) => {
    for (const [sessionId, entry] of sessions) {
      if (entry.projectId === projectId && entry.itemId === item.id && (TERMINAL_ITEM_STATES.includes(item.state) || !Object.values(item.sessions).includes(sessionId))) sessions.delete(sessionId);
    }
    if (TERMINAL_ITEM_STATES.includes(item.state)) return;
    if (!Object.keys(item.sessions).length) return;
    if (item.worktree === undefined) refuse();
    const placement = await resolvePlacement({ projectId, itemId: item.id, bot, directory: item.worktree, sessions: item.sessions });
    for (const stage of Object.keys(item.sessions)) {
      if (stage !== 'investigation' && stage !== 'fixing' && stage !== 'judge') continue;
      const sessionId = item.sessions[stage];
      if (sessionId !== undefined) track({ projectId, itemId: item.id, botId: item.botId,
        sessionId, stage, directory: item.worktree, isolated: placement.isolated });
    }
  };
  const owner = async (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (!entry?.isolated) refuse();
    const result = await isolated.sessionOwner({ sessionId });
    const { binding } = result;
    if (binding.projectId !== entry.projectId || binding.itemId !== entry.itemId || binding.botId !== entry.botId
      || binding.hostDirectory !== entry.directory) refuse();
    return result;
  };
  const normalize = (info: SessionInfo, isolated: boolean, archived = false) => ({ id: info.id, directory: info.location?.directory,
    isolated, archived: archived || Boolean(info.time?.archived), metadata: info.metadata });
  const readSession = async ({ projectId, item, bot, sessionId }: {
    readonly projectId: string; readonly item: BotItem; readonly bot: BotDefinition; readonly sessionId: string;
  }) => {
    await trackItem(projectId, item, bot);
    const entry = sessions.get(sessionId);
    if (!entry || entry.projectId !== projectId || entry.itemId !== item.id || entry.botId !== bot.id) refuse();
    if (entry.isolated) return normalize((await owner(sessionId)).info, true);
    if (hostExecution) return hostExecution.readSession(entry);
    const info = sessionInfoSchema.parse(unwrapOpenCodeResponse(await clientFor(entry.directory).session.get({ sessionID: sessionId })));
    return normalize(info, false, await isSessionArchived(sessionId));
  };
  const queueFor = async (target: QueueTarget): Promise<Queue> => {
    if (!target.isolated && !hostExecution) {
      if (!hostQueue) refuse();
      return hostQueue;
    }
    const entry = sessions.get(target.sessionId);
    if (!entry || entry.isolated !== target.isolated || entry.projectId !== target.projectId || entry.itemId !== target.itemId) refuse();
    const recorded = target.isolated ? await owner(target.sessionId) : null;
    const spaceId = recorded?.binding.spaceId ?? null;
    if ((recorded?.binding.directory ?? entry.directory) !== target.directory) refuse();
    const existing = queues.get(target.sessionId);
    if (existing) {
      if (started && !existing.release) existing.release = existing.queue.start();
      return existing.queue;
    }
    const listeners = new Set<(event: GlobalStreamEvent) => void>();
    const hostEntry = () => {
      const current = sessions.get(target.sessionId);
      if (stopped || !current || current.isolated || current.directory !== target.directory
        || current.projectId !== entry.projectId || current.itemId !== entry.itemId || current.botId !== entry.botId) refuse();
      return current;
    };
    const requestInside: NonNullable<MessageQueueOptions['fetchImpl']> = async (input, init) => {
      if (stopped) refuse();
      const scoped = [...sessions.values()].find((entry) => entry.isolated && entry.sessionId === target.sessionId);
      if (!scoped) refuse();
      const current = await owner(scoped.sessionId);
      if (current.binding.spaceId !== spaceId) refuse();
      return current.fetchImpl(input, init);
    };
    const fetchImpl: NonNullable<MessageQueueOptions['fetchImpl']> = (input, init) => trackTransfer(requestInside(input, init));
    const queue = createMessageQueueRuntime({
      dataDir: recorded ? path.join(dataDir, 'bots', 'isolated-queues', recorded.binding.spaceId, target.sessionId)
        : path.join(dataDir, 'bots', 'host-queues', target.sessionId),
      globalEventHub: { subscribeEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        subscribeStatus: () => () => {} },
      buildOpenCodeUrl: (route) => `http://space.invalid${route}`,
      getOpenCodeAuthHeaders: () => ({}), fetchImpl,
      botDispatchIsolated: target.isolated, assertBotDispatch: assertDispatch,
      botTransport: target.isolated || !hostExecution ? null : {
        isIdle: async () => { const working = await trackTransfer(hostExecution.isWorking(hostEntry())); return working === null ? null : !working; },
        deliverNotice: (notice) => trackTransfer(hostExecution.deliverNotice({ ...hostEntry(), ...notice })),
      },
      sessionKnowledgeRuntime: { sync: async (sessionId, _directory, input, options = input && !isString(input) ? input : {}) => {
        if (!target.isolated) {
          if (!hostExecution) refuse();
          await trackTransfer(hostExecution.syncKnowledge(hostEntry(), options));
          return true;
        }
        const current = await owner(sessionId);
        const { buildKnowledgeEntries } = await import('../session-knowledge/runtime.js');
        const entries = buildKnowledgeEntries(await sessionKnowledgeRuntime.collect(current.binding.hostDirectory), options);
        for (const [key, value] of Object.entries(entries)) if (value) await current.client.session.instructions.entry.put({ sessionID: sessionId, key, value });
        return true;
      } },
      broadcastGlobalUiEvent: (event) => {
        const properties: typeof event.properties & { spaceId?: string } = { ...event.properties };
        if (spaceId) properties.spaceId = spaceId;
        return broadcast({ ...event, properties });
      },
    });
    const queueEntry: QueueEntry = { queue, listeners, spaceId };
    queues.set(target.sessionId, queueEntry);
    await queue.load();
    if (started) queueEntry.release = queue.start();
    return queue;
  };
  const queueForSession = async (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (!entry) return hostQueue;
    if (!entry.isolated) return hostExecution ? queueFor(entry) : hostQueue;
    const { binding } = await owner(sessionId);
    return queueFor({ ...entry, directory: binding.directory });
  };
  const restore = async (onFailure: (entry: SessionEntry, cause: unknown) => void | Promise<void>) => {
    started = true;
    stopped = false;
    for (const entry of sessions.values()) if ((entry.isolated || hostExecution) && !entry.itemId.startsWith('discovery_')) {
      try {
        const directory = entry.isolated ? (await owner(entry.sessionId)).binding.directory : entry.directory;
        await queueFor({ ...entry, directory });
      } catch (error) { await onFailure(entry, error); }
    }
  };
  return {
    track, trackItem, get: (sessionId: string) => sessions.get(sessionId), entries: () => [...sessions.values()],
    readSession, queueFor, queueForSession, owner,
    processPayload(payload: TranslatedEvent, { spaceId }: { readonly spaceId?: string | null }) {
      const properties: JsonObject = payload.properties;
      const sessionId = properties.sessionID ?? (isJsonObject(properties.info) ? properties.info.id : undefined);
      if (!isString(sessionId)) return;
      const entry = sessions.get(sessionId);
      if (!entry || entry.isolated !== Boolean(spaceId)) return;
      const recorded = queues.get(sessionId);
      if (!recorded || recorded.spaceId !== (spaceId ?? null)) return;
      for (const listener of recorded.listeners) listener({ payload, directory: entry.directory, eventId: '',
        spaceId: spaceId ?? null, origin: spaceId ? 'space' : null, serialize: () => JSON.stringify(payload), translated: () => [payload] });
    },
    async isWorking(sessionId: string) {
      const entry = sessions.get(sessionId);
      if (!entry) return undefined;
      if (!entry.isolated) return hostExecution ? hostExecution.isWorking(entry) : undefined;
      const { probe } = await owner(sessionId);
      const statuses = await probe.fetchActiveSessionStatuses();
      if (statuses === null) return null;
      return Boolean(statuses[sessionId]) || probe.hasWorkingDescendants(sessionId, statuses);
    },
    async tokenSnapshot(sessionId: string, directory: string | null, options?: TokenOptions) {
      const entry = sessions.get(sessionId);
      if (!entry?.isolated) {
        if (hostExecution) {
          if (!entry || entry.directory !== directory) refuse();
          return hostExecution.readTokens(entry, options);
        }
        if (!readHostTokens) refuse();
        return readHostTokens(sessionId, directory, options);
      }
      const current = await owner(sessionId);
      return current.tokens(sessionId, current.binding.directory, options);
    },
    restore,
    async stop() {
      started = false; stopped = true;
      for (const { queue, release } of queues.values()) { release?.(); queue.stop(); }
      await Promise.allSettled([...transfers]);
      for (const { queue } of queues.values()) await queue.drain();
      queues.clear();
    },
  };
}
