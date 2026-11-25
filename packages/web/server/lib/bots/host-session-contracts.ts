import { z } from 'zod';
import type { BotItem } from './schema.js';
import type { createBotPlacement } from './placement.js';
import type { BotServiceReply } from '../agent-server/bot-service-contract.js';
import type { createMessageQueueRuntime, MessageQueueOptions } from '../message-queue/runtime.js';
import type { GlobalStreamEvent } from '../event-stream/global-hub.js';
import type { SessionActivityProbe } from '../opencode/session-activity.js';
import type { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import type { KnowledgeCollector, KnowledgeSyncOptions } from '../session-knowledge/contracts.js';
import type { JsonValue } from '../shared/json-values.js';
import type { BotConversationExecution } from './conversation-contract.js';

type SessionIdentity = {
  readonly projectId: string; readonly itemId: string; readonly botId: string;
  readonly sessionId: string; readonly directory: string;
};
type StageEntry = SessionIdentity & { readonly stage: keyof BotItem['sessions']; readonly role?: never; readonly isolated: boolean };
type ConversationEntry = SessionIdentity & { readonly role: 'conversation'; readonly conversation: NonNullable<BotItem['conversation']>; readonly stage?: never; readonly isolated: false };
export type SessionEntry = StageEntry | ConversationEntry;
export type QueueTarget = Omit<SessionEntry, 'botId'>;
export type Queue = ReturnType<typeof createMessageQueueRuntime>;
type TokenReader = ReturnType<typeof createTokenSnapshotReader>;
export type TokenOptions = Parameters<TokenReader>[2];
type Notice = Parameters<NonNullable<MessageQueueOptions['botTransport']>['deliverNotice']>[0];
export type SessionInfo = z.output<typeof sessionInfoSchema>;
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
  readSession(entry: StageEntry): Promise<BotServiceReply<'session'>>;
  isWorking(entry: StageEntry): Promise<boolean | null>;
  readTokens(entry: StageEntry, options?: TokenOptions): Promise<number | null>;
  syncKnowledge(entry: StageEntry, options?: KnowledgeSyncOptions): Promise<BotServiceReply<'knowledge-sync'> | void>;
  deliverNotice(entry: StageEntry & Notice): Promise<BotServiceReply<'synthetic-deliver'> | void>;
};
export type HostSessionsOptions = {
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
  readonly conversations?: BotConversationExecution | undefined;
  readonly resolveProject?: ((projectId: string) => Promise<{ readonly id: string; readonly path: string }>) | undefined;
};
export type QueueEntry = { readonly queue: Queue; readonly listeners: Set<(event: GlobalStreamEvent) => void>;
  readonly spaceId: string | null; release?: () => void };
export const sessionInfoSchema = z.object({ id: z.string(), location: z.object({ directory: z.string().optional() }).nullish(),
  time: z.object({ archived: z.unknown().optional() }).nullish(), metadata: z.unknown().optional() });
