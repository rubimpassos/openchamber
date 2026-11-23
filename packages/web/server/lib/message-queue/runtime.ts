import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { isRecord, isString } from '../shared/object-guards.js';
import type { Application, Response as HttpResponse } from '../shared/http-contracts.js';
import type { GlobalMessageStreamHub, GlobalStreamEvent } from '../event-stream/global-hub.js';
import type { createSessionKnowledgeRuntime } from '../session-knowledge/runtime.js';
import type { createRoutingRuntime } from '../routing/runtime.js';
import type { ScheduledTaskProvenance, createExistingSessionTasks } from '../scheduled-tasks/existing-session.js';
import type { ScheduledTaskInput, ScheduledTaskStatus } from '../projects/contracts.js';
import type { RoutingModelRef } from '../routing/contracts.js';
import { createMessageId } from '../dispatch-results/runtime.js';
import { assertPromptResponse } from '../opencode/prompt-response.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { attachmentHint } from '../routing/runtime.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { botNoticeIds, botNoticeSchema, requireBotNotice } from './bot-notice.js';
import type { createAutomationAdmission } from '../session-automation/runtime.js';
import { parseAttachment, toPublicAttachment, type PublicQueuedAttachment, type QueuedAttachment } from './attachments.js';

const QUEUE_FILE_NAME = 'message-queue.json';
const QUEUE_FILE_VERSION = 1;

const MAX_SESSIONS = 50;
const MAX_ITEMS_PER_SESSION = 20;
const CONTENT_CHAR_LIMIT = 200_000;

const DISPATCH_QUIET_MS = 500;
const ABORT_HOLD_MS = 2_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_TAIL_LIMIT = 2;
const ADMISSION_RECHECK_MS = 5_000;

const CONTEXT_PART_KINDS = new Set(['context', 'instruction', 'synthetic']);
// Server features that queue messages themselves. Their items keep the
// session's own model, like scheduled tasks.
const SERVER_ORIGIN_KINDS = new Set(['pr-fix-loop', 'pr-stack', 'bot']);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]{8,64}$/;

export interface QueueSendConfig {
  providerID?: string;
  modelID?: string;
  agent?: string;
  variant?: string;
}

export interface QueuedGoal {
  tokenBudget: number | null;
  objective?: string;
}

export type QueuedContextPart =
  | { kind: 'context'; text: string; metadata: QueueRecord; instructions?: string }
  | { kind: 'instruction' | 'synthetic'; text: string; metadata?: never };

export interface QueuedItemInput {
  content: string;
  text: string;
  agentMention?: string;
  attachments: QueuedAttachment[];
  context: QueuedContextPart[];
  contextPreview?: string;
  sendConfig: QueueSendConfig;
  goal?: QueuedGoal;
  scheduledTask?: ScheduledTaskProvenance;
  origin?: QueueOrigin;
  notice?: QueueRecord;
  messageId?: string;
}

export interface QueueOrigin {
  readonly kind: 'pr-fix-loop' | 'pr-stack' | 'bot';
  readonly id: string;
}

export interface QueuedItem extends QueuedItemInput {
  id: string;
  createdAt: number;
  syntheticIds?: string[];
}

export interface PublicQueuedItem extends Omit<QueuedItem, 'context' | 'syntheticIds' | 'attachments'> {
  attachments: PublicQueuedAttachment[];
}

export interface SessionQueue {
  directory: string;
  items: QueuedItem[];
}

export interface MessageQueueOptions {
  globalEventHub: Pick<GlobalMessageStreamHub, 'subscribeEvent' | 'subscribeStatus'>;
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  sessionKnowledgeRuntime?: Pick<ReturnType<typeof createSessionKnowledgeRuntime>, 'sync'> | null;
  broadcastGlobalUiEvent?: (event: { type: 'openchamber:message-queue.updated'; properties: { revision: number; session: MessageQueueSessionSnapshot } }) => void;
  onPromptSent?: (sessionId: string) => void;
  beforeScheduledTaskSend?: ReturnType<typeof createExistingSessionTasks>['beforeSend'];
  validateScheduledTaskTarget?: ReturnType<typeof createExistingSessionTasks>['validateTarget'];
  onScheduledTaskResult?: ReturnType<typeof createExistingSessionTasks>['result'];
  resolveAutoSelection?: ReturnType<typeof createRoutingRuntime>['resolveAutoSelection'] | null;
  persistSessionGoal?: Parameters<typeof createSessionGoal>[0]['persistSessionGoal'];
  isDeliveryHeld?: (sessionId: string) => boolean;
  deliveryHoldReady?: Promise<unknown>;
  automation?: ReturnType<typeof createAutomationAdmission> | null;
  assertFixLoopHostDispatch?: (sessionId: string, directory: string, origin: QueueOrigin) => Promise<unknown>;
  assertBotDispatch?: (input: {
    readonly sessionId: string;
    readonly directory: string;
    readonly origin: QueueOrigin | undefined;
    readonly notice: QueueRecord | undefined;
    readonly isolated: boolean;
  }) => Promise<{ includeMemorySaveRule: boolean }>;
  botDispatchIsolated?: boolean;
  botTransport?: {
    isIdle: (sessionId: string, directory: string | undefined) => Promise<boolean | null>;
    deliverNotice: (input: {
      readonly sessionId: string;
      readonly directory: string;
      readonly id: string;
      readonly text: string;
      readonly description: string;
      readonly notice: QueueRecord;
    }) => Promise<unknown>;
  } | null;
  dataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  dispatchQuietMs?: number;
  abortHoldMs?: number;
  retryDelayMs?: (failures: number) => number;
}

export interface MessageQueueSessionSnapshot {
  sessionId: string;
  directory: string;
  items: PublicQueuedItem[];
  sendingId: string | null;
}

const getQueuedSendRetryDelayMs = (failures: number) =>
  Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

const textSchema = z.unknown().transform((value) => isString(value) ? value : '');
const asNonEmptyString = z.unknown().transform((value) => isString(value) && value.trim() ? value.trim() : '').parse;
const asText = textSchema.parse;
const recordSchema = z.unknown().transform((value) => isRecord(value) ? value : null);
const asRecord = recordSchema.parse;
export type QueueRecord = NonNullable<z.output<typeof recordSchema>>;
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
const listSchema = z.unknown().transform((value) => isList(value) ? value : null);
const asList = listSchema.parse;
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const asCount = z.unknown().transform((value) => isFiniteNumber(value) && value >= 0 ? Math.floor(value) : null).parse;
const hasReadableFields = (value: unknown): value is { agent?: unknown; message?: unknown; status?: unknown; statusCode?: unknown } => value !== null && value !== undefined;
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const hasQueueBody = (value: unknown): value is { item?: unknown; directory?: unknown; itemIds?: unknown } => value !== null && value !== undefined;
const hasScheduledTaskField = (value: unknown): value is { scheduledTask?: unknown; origin?: unknown; notice?: unknown } => value !== null && value !== undefined;
const isScheduledItem = (item: QueuedItem): item is QueuedItem & { scheduledTask: ScheduledTaskProvenance } => Boolean(item.scheduledTask);
// The input parser establishes this notice shape whenever it admits a bot origin.
const isBotItem = (item: QueuedItemInput): item is QueuedItemInput & { notice: ReturnType<typeof requireBotNotice> } => item.origin?.kind === 'bot';

interface QueueModel {
  id: string | undefined;
  providerID: string | undefined;
  variant?: string;
}

type PromptFile = {
  uri: string;
  name?: string;
};

interface CommandBody {
  name: string;
  text: string;
  files?: PromptFile[];
}

interface PromptBody {
  text: string;
  files?: PromptFile[];
  agents?: { name: string }[];
}

const hasSelectedModel = (model: QueueModel): model is QueueModel & RoutingModelRef => Boolean(model.providerID && model.id);

const isValidSessionId = (value: string | undefined): value is string => SESSION_ID_PATTERN.test(asNonEmptyString(value));

const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

const sendConfigSchema = z.unknown().transform((value): QueueSendConfig | null => {
  const raw = asRecord(value);
  if (!raw) return null;
  const providerID = asNonEmptyString(raw.providerID);
  const modelID = asNonEmptyString(raw.modelID);
  if (!providerID || !modelID) return null;
  const sendConfig: QueueSendConfig = { providerID, modelID };
  const agent = asNonEmptyString(raw.agent);
  if (agent) sendConfig.agent = agent;
  const variant = asNonEmptyString(raw.variant);
  if (variant) sendConfig.variant = variant;
  return sendConfig;
});
const parseSendConfig = sendConfigSchema.parse;

const goalSchema = z.unknown().transform((value): QueuedGoal | null => {
  if (value === undefined) return null;
  const raw = asRecord(value);
  if (!raw) throw new TypeError('invalid goal');
  const tokenBudget = raw.tokenBudget ?? null;
  if (tokenBudget !== null && !(isInteger(tokenBudget) && tokenBudget > 0)) throw new TypeError('invalid goal tokenBudget');
  const goal: QueuedGoal = { tokenBudget };
  const objective = asNonEmptyString(raw.objective);
  if (objective) goal.objective = objective;
  return goal;
});
const parseGoal = goalSchema.parse;

const isContextKind = (value: unknown): value is QueuedContextPart['kind'] => isString(value) && CONTEXT_PART_KINDS.has(value);

const FIX_LOOP_NOTICE_LIMIT = 64 * 1024;

// The transcript row of a fix-loop message: kept and sent as the message's
// metadata. The fix loop builds it; its shape is the UI's to validate.
const parseFixLoopNotice = (value: unknown, loopId: string) => {
  const raw = asRecord(value);
  if (!raw) return { source: 'openchamber-notice', kind: 'fix-loop', loopId };
  if (raw.source !== 'openchamber-notice' || raw.kind !== 'fix-loop' || raw.loopId !== loopId) {
    throw new TypeError('invalid fix-loop notice');
  }
  if (JSON.stringify(raw).length > FIX_LOOP_NOTICE_LIMIT) throw new TypeError('fix-loop notice is too large');
  return raw;
};

const contextPartSchema = z.unknown().transform((value): QueuedContextPart | null => {
  const raw = asRecord(value);
  if (!raw || !isContextKind(raw.kind)) return null;
  const text = asText(raw.text);
  if (raw.kind !== 'context') return { kind: raw.kind, text };
  const metadata = asRecord(raw.metadata);
  if (!metadata) return null;
  const part: QueuedContextPart = { kind: 'context', text, metadata };
  const instructions = asNonEmptyString(raw.instructions);
  if (instructions) part.instructions = instructions;
  return part;
});
const parseContextPart = contextPartSchema.parse;

const queuedItemInputSchema = z.unknown().transform((value): QueuedItemInput => {
  const raw = asRecord(value);
  if (!raw) throw new TypeError('item is required');
  const content = asText(raw.content).replace(/^\n+|\n+$/g, '');
  if (content.length > CONTENT_CHAR_LIMIT) throw new TypeError('item content is too long');
  const text = raw.text === undefined ? content : asText(raw.text);
  const attachments = (asList(raw.attachments) ?? []).map((entry) => parseAttachment(entry));
  if (!attachments.every((attachment) => attachment !== null)) throw new TypeError('invalid attachment');
  const context = (asList(raw.context) ?? []).map((entry) => parseContextPart(entry));
  if (!context.every((part) => part !== null)) throw new TypeError('invalid context part');
  if (!text.trim() && attachments.length === 0 && context.length === 0) {
    throw new TypeError('item needs text, attachments, or context');
  }
  const sendConfig = parseSendConfig(raw.sendConfig);
  const provenance = asRecord(raw.scheduledTask);
  const projectId = asNonEmptyString(provenance?.projectId);
  const taskId = asNonEmptyString(provenance?.taskId);
  if (provenance && (!projectId || !taskId)) throw new TypeError('invalid scheduledTask provenance');
  const originRecord = asRecord(raw.origin);
  const isOriginKind = (value: unknown): value is QueueOrigin['kind'] => typeof value === 'string' && SERVER_ORIGIN_KINDS.has(value);
  const origin = originRecord && isOriginKind(originRecord.kind) && asNonEmptyString(originRecord.id)
    ? { kind: originRecord.kind, id: asNonEmptyString(originRecord.id) }
    : null;
  if (originRecord && !origin) throw new TypeError('invalid origin');
  if (!sendConfig && !provenance && !origin) throw new TypeError('item sendConfig with providerID and modelID is required');
  const goal = parseGoal(raw.goal);
  if (goal && !text.trim()) throw new TypeError('a goal needs message text');
  const item: Omit<QueuedItemInput, 'attachments' | 'context' | 'sendConfig'> & Partial<Pick<QueuedItemInput, 'attachments' | 'context' | 'sendConfig'>> = { content, text };
  const agentMention = asNonEmptyString(raw.agentMention);
  if (agentMention) item.agentMention = agentMention;
  item.attachments = attachments;
  item.context = context;
  const contextPreview = asNonEmptyString(raw.contextPreview).slice(0, 103);
  if (contextPreview) item.contextPreview = contextPreview;
  item.sendConfig = sendConfig ?? {};
  if (goal) item.goal = goal;
  if (provenance) {
    item.scheduledTask = { projectId, taskId };
    const agent = asNonEmptyString(hasReadableFields(raw.sendConfig) ? raw.sendConfig.agent : undefined);
    if (agent) item.sendConfig.agent = agent;
  }
  if (origin) item.origin = origin;
  if (raw.notice !== undefined && origin?.kind !== 'pr-fix-loop' && origin?.kind !== 'bot') throw new TypeError('notice needs a server notice origin');
  if (origin?.kind === 'bot') {
    if (provenance || goal || agentMention || attachments.length || context.length || Object.keys(item.sendConfig).length) {
      throw new TypeError('bot notices retain the session selection and carry text only');
    }
    const notice = requireBotNotice(botNoticeSchema.safeParse(raw.notice).data, origin.id);
    item.notice = notice;
    item.messageId = botNoticeIds(notice).messageId;
  }
  if (origin?.kind === 'pr-fix-loop') {
    item.notice = parseFixLoopNotice(raw.notice, origin.id);
    // Kept with the item, so a retry after a lost response cannot admit the message twice.
    const messageId = asNonEmptyString(raw.messageId);
    item.messageId = MESSAGE_ID_PATTERN.test(messageId) ? messageId : createMessageId(Date.now());
  }
  return Object.assign(item, { attachments: item.attachments, context: item.context, sendConfig: item.sendConfig });
});
export const parseQueuedItemInput = queuedItemInputSchema.parse;

const storedItemSchema = z.unknown().transform((value): QueuedItem | null => {
  const raw = asRecord(value);
  const id = raw ? asNonEmptyString(raw.id) : '';
  if (!raw || !id) return null;
  try {
    const item: QueuedItem = { id, createdAt: asCount(raw.createdAt) ?? Date.now(), ...parseQueuedItemInput(raw) };
    const syntheticIds = asList(raw.syntheticIds) ?? [];
    if (syntheticIds.length > 0 && syntheticIds.every((entry): entry is string => MESSAGE_ID_PATTERN.test(asText(entry)))) item.syntheticIds = syntheticIds;
    return item;
  } catch {
    return null;
  }
});
const parseStoredItem = storedItemSchema.parse;

const toPublicItem = (item: QueuedItem) => {
  const publicItem: Omit<PublicQueuedItem, 'attachments' | 'sendConfig'> & Partial<Pick<PublicQueuedItem, 'attachments' | 'sendConfig'>> = { id: item.id, createdAt: item.createdAt, content: item.content, text: item.text };
  if (item.agentMention) publicItem.agentMention = item.agentMention;
  publicItem.attachments = item.attachments.map(toPublicAttachment);
  const contextPreview = item.contextPreview || item.context
    .filter((part) => part.kind !== 'instruction')
    .map((part) => asNonEmptyString(asRecord(part.metadata?.openchamberContext)?.text) || part.text.trim())
    .find(Boolean);
  if (contextPreview) {
    const [firstLine = ''] = contextPreview.split('\n', 1);
    publicItem.contextPreview = firstLine.slice(0, 100)
      + (contextPreview.length > firstLine.length || firstLine.length > 100 ? '...' : '');
  }
  publicItem.sendConfig = { ...item.sendConfig };
  if (item.goal) publicItem.goal = { ...item.goal };
  if (item.scheduledTask) publicItem.scheduledTask = { ...item.scheduledTask };
  if (item.origin) publicItem.origin = { ...item.origin };
  return Object.assign(publicItem, { attachments: publicItem.attachments, sendConfig: publicItem.sendConfig });
};

const extractSessionStatus = (payload: QueueRecord) => {
  if (payload.type !== 'session.status') return null;
  const properties = asRecord(payload.properties) ?? {};
  const status = asRecord(properties.status) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(properties.sessionID);
  const type = asNonEmptyString(status.type) || asNonEmptyString(info.type);
  if (!sessionId || !type) return null;
  return { sessionId, type };
};

const extractAssistantMessageUpdate = (payload: QueueRecord) => {
  if (payload.type !== 'message.updated') return null;
  const info = asRecord(asRecord(payload.properties)?.info);
  if (!info || info.role !== 'assistant') return null;
  const sessionId = asNonEmptyString(info.sessionID);
  if (!sessionId) return null;
  return {
    sessionId,
    completed: asCount(asRecord(info.time)?.completed) !== null,
  };
};

const extractAbortedSessionId = (payload: QueueRecord) => {
  if (payload.type !== 'session.idle') return null;
  const properties = asRecord(payload.properties) ?? {};
  if (properties.aborted !== true) return null;
  return asNonEmptyString(properties.sessionID);
};

const extractDeletedSessionId = (payload: QueueRecord) => {
  if (payload.type !== 'session.deleted') return null;
  const properties = asRecord(payload.properties) ?? {};
  return asNonEmptyString(asRecord(properties.info)?.id) || asNonEmptyString(properties.sessionID) || null;
};

const extractSessionDirectoryUpdate = (payload: QueueRecord) => {
  if (payload.type !== 'session.updated') return null;
  const properties = asRecord(payload.properties) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(info.id) || asNonEmptyString(properties.sessionID);
  const directory = asNonEmptyString(info.directory);
  const projectID = asNonEmptyString(info.projectID);
  return sessionId && directory && projectID ? { sessionId, directory } : null;
};

export function createMessageQueueRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime = null,
  broadcastGlobalUiEvent,
  onPromptSent,
  beforeScheduledTaskSend,
  validateScheduledTaskTarget,
  assertFixLoopHostDispatch,
  assertBotDispatch,
  // True only for a queue whose transport and persistence belong to that space.
  botDispatchIsolated = false,
  // Dedicated owner Bot queues use bounded execution operations across accounts.
  botTransport = null,
  onScheduledTaskResult,
  resolveAutoSelection = null,
  persistSessionGoal = null,
  isDeliveryHeld = () => false,
  deliveryHoldReady = Promise.resolve(),
  automation = null,
  dataDir,
  fetchImpl = fetch,
  now = Date.now,
  dispatchQuietMs = DISPATCH_QUIET_MS,
  abortHoldMs = ABORT_HOLD_MS,
  retryDelayMs = getQueuedSendRetryDelayMs,
}: MessageQueueOptions) {
  const filePath = path.join(dataDir, QUEUE_FILE_NAME);

  const queues = new Map<string, SessionQueue>();
  let revision = 0;
  let loadPromise: Promise<void> | null = null;
  let writePromise = Promise.resolve();
  let writeResult = writePromise;
  let stopped = false;

  const runtimeStartedAt = now();

  const sending = new Map<string, string>();
  const dispatches = new Set<Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, { itemId: string; failures: number; nextAttemptAt: number }>();
  const abortedAt = new Map<string, number>();
  const directories = new Map<string, string | undefined>();

  const serialize = () => ({
    version: QUEUE_FILE_VERSION,
    revision,
    sessions: Object.fromEntries(
      Array.from(queues.entries()).map(([sessionId, queue]) => [sessionId, { directory: queue.directory, items: queue.items }]),
    ),
  });

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return { sessions: {}, revision: 0 };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[message-queue] queue file was unreadable and moved to ${backup}: ${(hasReadableFields(error) ? error.message : undefined) ?? error}`);
      return { sessions: {}, revision: 0 };
    }
    const stored = asRecord(parsed) ?? {};
    const sessions: Record<string, SessionQueue> = {};
    for (const [sessionId, value] of Object.entries(asRecord(stored.sessions) ?? {})) {
      const entry = asRecord(value);
      if (!entry || !isValidSessionId(sessionId)) continue;
      const directory = asNonEmptyString(entry.directory);
      const items = (asList(entry.items) ?? []).map((entry) => parseStoredItem(entry)).filter((item) => item !== null);
      if (!directory || items.length === 0) continue;
      sessions[sessionId] = { directory, items };
    }
    return { sessions, revision: asCount(stored.revision) ?? 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const [sessionId, entry] of Object.entries(stored.sessions)) queues.set(sessionId, entry);
          revision = Math.max(revision, stored.revision);
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify(serialize());
    writeResult = writePromise.then(async () => {
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
    });
    writePromise = writeResult.catch((error) => {
      console.warn('[message-queue] failed to persist queue:', error?.message ?? error);
    });
    return writeResult;
  };

  const sessionSnapshot = (sessionId: string): MessageQueueSessionSnapshot => {
    const queue = queues.get(sessionId);
    return {
      sessionId,
      directory: queue?.directory ?? directories.get(sessionId) ?? '',
      items: (queue?.items ?? []).map(toPublicItem),
      sendingId: sending.get(sessionId) ?? null,
    };
  };

  const snapshot = () => ({
    revision,
    sessions: Array.from(queues.keys()).map(sessionSnapshot),
  });

  const broadcast = (sessionId: string) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:message-queue.updated',
      properties: { revision, session: sessionSnapshot(sessionId) },
    });
  };

  const commit = (sessionId: string) => {
    revision += 1;
    persist().catch(() => undefined);
    broadcast(sessionId);
    return { revision, session: sessionSnapshot(sessionId) };
  };

  const reportScheduledResult = (item: QueuedItem, status: ScheduledTaskStatus, cause?: unknown) => {
    if (!isScheduledItem(item)) return;
    Promise.resolve().then(() => onScheduledTaskResult?.(item.scheduledTask, status, cause))
      .catch((failure) => console.warn('[message-queue] scheduled task state write failed:', failure?.message ?? failure));
  };

  const setQueueItems = (sessionId: string, directory: string | undefined, items: QueuedItem[], status: ScheduledTaskStatus = 'cancelled', cause?: unknown) => {
    for (const item of queues.get(sessionId)?.items ?? []) {
      if (item.scheduledTask && !items.some((entry) => entry.id === item.id)) reportScheduledResult(item, status, cause);
    }
    directories.set(sessionId, directory);
    if (items.length === 0) {
      queues.delete(sessionId);
      return;
    }
    if (directory === undefined) throw new Error('Message queue directory is missing');
    queues.set(sessionId, { directory, items });
  };

  const openCodeFetch = async (fetchPath: string, { directory, method = 'GET', body, query }: { directory?: string | undefined; method?: string; body?: object; query?: Record<string, string> } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const headers: ReturnType<MessageQueueOptions['getOpenCodeAuthHeaders']> = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    if (method === 'POST') {
      await assertPromptResponse(response, 'OpenCode dispatch');
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  const isSessionIdle = async (sessionId: string, directory: string | undefined) => {
    if (botTransport) {
      try { return await botTransport.isIdle(sessionId, directory); }
      catch { return null; }
    }
    const body = asRecord(await openCodeFetch('/api/session/active').catch(() => null));
    const statuses = asRecord(body && 'data' in body ? body.data : body);
    if (!statuses) return null;
    if (asRecord(statuses[sessionId])) return false;
    const page = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_TAIL_LIMIT) },
    }).catch(() => null);
    const messages = asList(asRecord(page)?.data);
    if (!messages) return null;
    const last = asRecord(messages[0]);
    const lastTime = asRecord(last?.time);
    if (last?.type === 'assistant' && asCount(lastTime?.completed) === null) {
      const created = asCount(lastTime?.created);
      if (created === null || created >= runtimeStartedAt) return false;
      console.log(`[message-queue] ignoring pre-boot unfinished tail for ${sessionId}`);
    }
    return true;
  };

  const resolveSlashCommand = async (text: string, directory: string | undefined) => {
    if (!text.startsWith('/')) return null;
    const [head = '', ...tail] = text.split(' ');
    const name = head.slice(1);
    if (!name) return null;
    const commands = asList(await openCodeFetch('/api/command', { directory })) ?? [];
    const match = commands.map((command) => asRecord(command)).find((command) => command?.name === name);
    if (!match) return null;
    return {
      name,
      arguments: tail.join(' '),
    };
  };

  const toPromptFile = (attachment: QueuedAttachment) => {
    const file: PromptFile = { uri: attachment.dataUrl };
    if (attachment.agentPath || attachment.filename) file.name = attachment.agentPath || attachment.filename;
    return file;
  };

  const toContextMessages = (part: QueuedContextPart) => {
    const body = { text: part.text, resume: false };
    if (part.kind !== 'context') return [body];
    const withMetadata = part.metadata ? { ...body, metadata: part.metadata } : body;
    return part.instructions
      ? [{ text: part.instructions, resume: false }, withMetadata]
      : [withMetadata];
  };

  const ensureSyntheticIds = async (item: QueuedItem, count: number) => {
    if (item.syntheticIds?.length === count) return;
    const firstAt = now() - count + 1;
    item.syntheticIds = Array.from({ length: count }, (_, index) => createMessageId(firstAt + index));
    try {
      await persist();
    } catch (error) {
      delete item.syntheticIds;
      throw error;
    }
  };

  const sendItem = async (sessionId: string, directory: string, item: QueuedItem) => {
    if (botTransport && item.origin?.kind !== 'bot') throw httpError('A dedicated Bot queue accepts Bot notices only', 409);
    const assertAdmission = async () => {
      if (item.origin?.kind === 'pr-fix-loop') {
        if (!assertFixLoopHostDispatch) throw httpError('Fix-loop host dispatch authority is unavailable', 409);
        await assertFixLoopHostDispatch(sessionId, directory, item.origin);
      }
      if (stopped || isDeliveryHeld(sessionId)) throw httpError('Queued delivery is held', 409);
    };
    const write = async (fetchPath: string, options: Parameters<typeof openCodeFetch>[1]) => {
      await assertAdmission();
      return openCodeFetch(fetchPath, options);
    };
    await assertAdmission();
    if (item.origin?.kind === 'bot') {
      const policy = await assertBotAuthority(sessionId, directory, item);
      // A failed admission write cannot be followed by a remote effect.
      await persist();
      await assertAdmission();
      if (sessionKnowledgeRuntime) await sessionKnowledgeRuntime.sync(sessionId, directory, policy);
      await assertBotAuthority(sessionId, directory, item);
      await assertAdmission();
      await sendNotice(sessionId, directory, item);
      return;
    }
    const { providerID, modelID, variant } = item.sendConfig;
    let agent = item.sendConfig.agent;
    let model: QueueModel = { id: modelID, providerID };
    if (variant) model.variant = variant;
    const promptFiles = item.attachments.map(toPromptFile);
    const synthetics = [
      ...item.context.flatMap(toContextMessages),
      ...(item.goal ? [{ text: buildGoalIntroText(item.goal.tokenBudget), resume: false }] : []),
    ];

    const routed = hasSelectedModel(model) ? await resolveAutoSelection?.({
      sessionId,
      directory,
      model,
      agent,
      requestText: `${item.text}${attachmentHint({ files: promptFiles })}`.trim(),
    }) : null;
    if (routed) {
      model = routed.model;
      agent = routed.agent ?? agent;
    }

    if ((!item.scheduledTask && !item.origin) || (providerID && modelID)) await write(`/api/session/${encodeURIComponent(sessionId)}/model`, {
      directory,
      method: 'POST',
      body: { model },
    });
    if (agent) {
      await write(`/api/session/${encodeURIComponent(sessionId)}/agent`, {
        directory,
        method: 'POST',
        body: { agent },
      });
    }

    const command = await resolveSlashCommand(item.text, directory);

    await assertAdmission();
    if (sessionKnowledgeRuntime) await sessionKnowledgeRuntime.sync(sessionId, directory);

    if (synthetics.length > 0) {
      await ensureSyntheticIds(item, synthetics.length);
      const session = asRecord(await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`, { directory }));
      if (!session) throw new Error(`OpenCode returned no record for session ${sessionId}`);
      if (session.revert) {
        await write(`/api/session/${encodeURIComponent(sessionId)}/revert/commit`, { directory, method: 'POST' });
      }
    }

    if (item.goal) {
      await assertAdmission();
      await createSessionGoal({
        persistSessionGoal,
        sessionID: sessionId,
        directory,
        objective: item.goal.objective || item.text,
        tokenBudget: item.goal.tokenBudget,
        providerID: model.providerID,
        modelID: model.id,
        onWarning: (message: string, cause: unknown) => console.warn(`[message-queue] ${message}:`, (hasReadableFields(cause) ? cause.message : undefined) || cause),
      });
    }

    for (const [index, synthetic] of synthetics.entries()) {
      if (!item.syntheticIds) throw new Error('Queued synthetic IDs are missing');
      await write(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
        directory,
        method: 'POST',
        body: { id: item.syntheticIds[index], ...synthetic },
      });
    }
    if (item.origin?.kind === 'pr-fix-loop') {
      // OpenChamber writes this message, so it arrives as a synthetic one whose
      // metadata the transcript renders as a fix-loop row; the agent reads the
      // full text and `resume` starts its turn.
      await assertAdmission();
      await sendNotice(sessionId, directory, item);
    } else if (command) {
      const body: CommandBody = { name: command.name, text: command.arguments };
      if (promptFiles.length > 0) body.files = promptFiles;
      await write(`/api/session/${encodeURIComponent(sessionId)}/command`, {
        directory,
        method: 'POST',
        body,
      });
    } else {
      const body: PromptBody = { text: item.text };
      if (promptFiles.length > 0) body.files = promptFiles;
      if (item.agentMention) body.agents = [{ name: item.agentMention }];
      await write(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
        directory,
        method: 'POST',
        body,
      });
    }
  };

  const assertBotAuthority = async (sessionId: string, directory: string, item: QueuedItemInput) => {
    if (!assertBotDispatch) throw httpError('Bot dispatch authority is unavailable', 409);
    const policy = await assertBotDispatch({ sessionId, directory, origin: item.origin, notice: item.notice, isolated: botDispatchIsolated });
    if (policy?.includeMemorySaveRule !== true && policy?.includeMemorySaveRule !== false) throw httpError('Bot dispatch policy is unavailable', 409);
    return { includeMemorySaveRule: policy.includeMemorySaveRule };
  };

  const sendNotice = async (sessionId: string, directory: string, item: QueuedItem) => {
    if (!item.messageId || !item.notice) throw new Error('Queued server notice identity is missing');
    // Typed execution already handles only the exact synthetic duplicate case.
    // Its other conflicts are authority refusals, not successful deliveries.
    if (botTransport) return botTransport.deliverNotice({ sessionId, directory, id: item.messageId,
      text: item.text, description: item.content, notice: item.notice });
    try {
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
        directory, method: 'POST', body: {
          id: item.messageId, text: item.text, description: item.content,
          metadata: item.notice, delivery: 'steer', resume: true,
        },
      });
    } catch (error) {
      // Our id was admitted by an earlier attempt whose answer was lost.
      if (!hasReadableFields(error) || error.status !== 409) throw error;
    }
  };

  const clearTimer = (sessionId: string) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(sessionId);
    }
  };

  const armDispatch = (sessionId: string, delayMs = dispatchQuietMs) => {
    if (stopped || !queues.has(sessionId)) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      const dispatch = tick(sessionId).catch((error) => {
        console.warn('[message-queue] dispatch tick failed:', (hasReadableFields(error) ? error.message : undefined) ?? error);
      });
      dispatches.add(dispatch);
      void dispatch.then(() => dispatches.delete(dispatch));
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  async function tick(sessionId: string) {
    if (stopped) return;
    const queue = queues.get(sessionId);
    if (!queue || queue.items.length === 0 || sending.has(sessionId) || isDeliveryHeld(sessionId)) return;

    const abortHoldUntil = (abortedAt.get(sessionId) ?? 0) + abortHoldMs;
    if (abortHoldUntil > now()) {
      armDispatch(sessionId, abortHoldUntil - now());
      return;
    }

    const head = queue.items[0];
    if (!head) throw new Error('Message queue head is missing');
    const failure = failures.get(sessionId);
    if (failure && failure.itemId !== head.id) failures.delete(sessionId);
    else if (failure && failure.nextAttemptAt > now()) {
      armDispatch(sessionId, failure.nextAttemptAt - now());
      return;
    }

    const idle = await isSessionIdle(sessionId, queue.directory);
    if (idle === null) {
      if (head.scheduledTask && validateScheduledTaskTarget) {
        try {
          await validateScheduledTaskTarget(head.scheduledTask.projectId, sessionId);
        } catch (error) {
          if (hasReadableFields(error) && (error.statusCode === 404 || error.statusCode === 409)) {
            const after = queues.get(sessionId);
            if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== head.id), 'failed', error.message);
            commit(sessionId);
            armDispatch(sessionId);
            return;
          }
        }
      }
      armDispatch(sessionId, retryDelayMs(1));
      return;
    }
    if (!idle) return;

    if (head.origin?.kind === 'bot' && !botTransport) {
      const statuses = await activityProbe.fetchActiveSessionStatuses();
      const descendants = statuses ? await activityProbe.hasWorkingDescendants(sessionId, statuses) : null;
      if (descendants !== false) {
        armDispatch(sessionId, descendants === null ? retryDelayMs(1) : ADMISSION_RECHECK_MS);
        return;
      }
    }

    const current = queues.get(sessionId);
    const item = current?.items[0];
    if (!current || !item || item.id !== head.id || sending.has(sessionId) || isDeliveryHeld(sessionId) || stopped) return;

    let releaseSend: (() => void) | null | undefined;
    if (automation) {
      await automation.ready();
      if (stopped || isDeliveryHeld(sessionId) || queues.get(sessionId)?.items[0] !== item || sending.has(sessionId)) return;
      releaseSend = automation.trySend(item.origin?.kind === 'pr-fix-loop' ? `fixloop:${item.origin.id}` : null, [`session:${sessionId}`]);
      if (!releaseSend) { armDispatch(sessionId, ADMISSION_RECHECK_MS); return; }
    }

    sending.set(sessionId, item.id);
    broadcast(sessionId);
    try {
      if (isScheduledItem(item)) {
        try {
          await beforeScheduledTaskSend?.(sessionId, current.directory, item);
        } catch (error) {
          if (!hasReadableFields(error) || (error.statusCode !== 404 && error.statusCode !== 409)) throw error;
          sending.delete(sessionId);
          const after = queues.get(sessionId);
          if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id), 'failed', error.message);
          failures.delete(sessionId);
          commit(sessionId);
          armDispatch(sessionId);
          return;
        }
      }
      await sendItem(sessionId, current.directory, item);
      const after = queues.get(sessionId);
      if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id), 'sent');
      failures.delete(sessionId);
      sending.delete(sessionId);
      commit(sessionId);
      try {
        onPromptSent?.(sessionId);
      } catch {
        void 0;
      }
      console.log(`[message-queue] sent queued message to ${sessionId}`);
    } catch (error) {
      sending.delete(sessionId);
      const count = (failure?.itemId === item.id ? failure.failures : 0) + 1;
      const nextAttemptAt = now() + retryDelayMs(count);
      failures.set(sessionId, { itemId: item.id, failures: count, nextAttemptAt });
      console.warn(`[message-queue] send to ${sessionId} failed (attempt ${count}):`, (hasReadableFields(error) ? error.message : undefined) ?? error);
      broadcast(sessionId);
      armDispatch(sessionId, nextAttemptAt - now());
    } finally {
      releaseSend?.();
    }
  }

  const reconcileAll = () => {
    for (const sessionId of queues.keys()) {
      if (!timers.has(sessionId)) armDispatch(sessionId, dispatchQuietMs);
    }
  };

  const requireSessionId = (sessionId: string | undefined) => {
    if (!isValidSessionId(sessionId)) throw new TypeError('sessionId is invalid');
    return sessionId;
  };

  const enqueue = async (sessionIdInput: string | undefined, directoryInput: z.input<typeof textSchema>, itemInput: z.input<typeof queuedItemInputSchema>) => {
    const sessionId = requireSessionId(sessionIdInput);
    const directory = asNonEmptyString(directoryInput);
    if (!directory) throw new TypeError('directory is required');
    const parsed = parseQueuedItemInput(itemInput);
    await load();
    if (isBotItem(parsed)) {
      await assertBotAuthority(sessionId, directory, parsed);
      const id = botNoticeIds(parsed.notice).itemId;
      for (const [ownerId, queue] of queues) {
        const existing = queue.items.find((entry) => entry.id === id);
        if (!existing) continue;
        if (ownerId !== sessionId || queue.directory !== directory || existing.text !== parsed.text) {
          throw httpError('bot notice identity is already queued with another target or text', 409);
        }
        await persist();
        armDispatch(sessionId);
        return { revision, session: sessionSnapshot(sessionId), itemId: id };
      }
      if ((queues.get(sessionId)?.items.length ?? 0) >= MAX_ITEMS_PER_SESSION || (!queues.has(sessionId) && queues.size >= MAX_SESSIONS)) {
        throw httpError('message queue is full', 409);
      }
    }
    if (parsed.scheduledTask) {
      for (const queue of queues.values()) {
        const provenance = parsed.scheduledTask;
        if (queue.items.some((entry) => entry.scheduledTask?.projectId === provenance.projectId && entry.scheduledTask.taskId === provenance.taskId)) {
          throw httpError('task is already queued', 409);
        }
      }
      if ((queues.get(sessionId)?.items.length ?? 0) >= MAX_ITEMS_PER_SESSION || (!queues.has(sessionId) && queues.size >= MAX_SESSIONS)) {
        throw httpError('message queue is full', 409);
      }
    }
    const currentQueue = queues.get(sessionId);
    if (currentQueue && currentQueue.items.length >= MAX_ITEMS_PER_SESSION && currentQueue.items.some((entry) => entry.origin?.kind === 'bot')) {
      throw httpError('message queue is full', 409);
    }
    if (!currentQueue && queues.size >= MAX_SESSIONS
      && Array.from(queues.values()).some((queue) => queue.items.some((entry) => entry.origin?.kind === 'bot'))
      && !Array.from(queues).some(([id, queue]) => !sending.has(id) && !queue.items.some((entry) => entry.origin?.kind === 'bot'))) {
      throw httpError('message queue is full', 409);
    }
    const item = {
      id: isBotItem(parsed) ? botNoticeIds(parsed.notice).itemId : `queued-${now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now(),
      ...parsed,
    };
    const existing = queues.get(sessionId);
    const items = [...(existing?.items ?? []), item].slice(-MAX_ITEMS_PER_SESSION);
    setQueueItems(sessionId, directory, items);
    directories.set(sessionId, directory);
    if (queues.size > MAX_SESSIONS) {
      const oldest = Array.from(queues.entries())
        .filter(([id, queue]) => id !== sessionId && !sending.has(id) && !queue.items.some((entry) => entry.origin?.kind === 'bot'))
        .sort((left, right) => (left[1].items[0]?.createdAt ?? 0) - (right[1].items[0]?.createdAt ?? 0))
        .slice(0, queues.size - MAX_SESSIONS);
      for (const [staleId] of oldest) {
        setQueueItems(staleId, directories.get(staleId), []);
        clearTimer(staleId);
        broadcast(staleId);
        directories.delete(staleId);
      }
    }
    const result = commit(sessionId);
    if (parsed.origin?.kind === 'bot') await writeResult;
    // The session may already be idle (queued from a busy-looking composer
    // right as the turn ended); the tick verifies before sending.
    armDispatch(sessionId);
    return { ...result, itemId: item.id };
  };

  const remove = async (sessionIdInput: string | undefined, itemId: string | undefined) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    if (!queue || !queue.items.some((item) => item.id === itemId)) {
      return { revision, session: sessionSnapshot(sessionId) };
    }
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id !== itemId));
    return commit(sessionId);
  };

  const take = async (sessionIdInput: string | undefined, itemId: string | undefined) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || !item) throw httpError('queued message not found', 404);
    if (item.scheduledTask) throw httpError('scheduled messages cannot be taken', 409);
    if (item.origin?.kind === 'bot') throw httpError('bot notices cannot be taken', 409);
    setQueueItems(sessionId, queue.directory, queue.items.filter((entry) => entry.id !== itemId));
    return { ...commit(sessionId), item };
  };

  const takeAll = async (sessionIdInput: string | undefined) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId), items: [] };
    const sendingId = sending.get(sessionId) ?? null;
    const items = queue.items.filter((item) => item.id !== sendingId && !item.scheduledTask && item.origin?.kind !== 'bot');
    if (items.length === 0) return { revision, session: sessionSnapshot(sessionId), items: [] };
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId || item.scheduledTask || item.origin?.kind === 'bot'));
    return { ...commit(sessionId), items };
  };

  const reorder = async (sessionIdInput: string | undefined, itemIds: z.input<typeof listSchema>) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (!isList(itemIds) || itemIds.some((id) => !asNonEmptyString(id))) {
      throw new TypeError('itemIds must be a list of ids');
    }
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    const hasQueuedId = (id: unknown): id is string => isString(id) && byId.has(id);
    if (itemIds.length !== byId.size || new Set(itemIds).size !== itemIds.length || !itemIds.every(hasQueuedId)) {
      throw new TypeError('itemIds must list every queued message exactly once');
    }
    queues.set(sessionId, { directory: queue.directory, items: itemIds.map((id) => {
      const item = byId.get(id);
      if (!item) throw new Error('Queued message is missing');
      return item;
    }) });
    return commit(sessionId);
  };

  const clear = async (sessionIdInput: string | undefined) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    const sendingId = sending.get(sessionId) ?? null;
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId));
    clearTimer(sessionId);
    return commit(sessionId);
  };

  const release = (sessionId: string) => {
    armDispatch(sessionId);
  };

  const processPayload = z.unknown().transform((value) => {
    const payload = asRecord(value);
    if (stopped || !payload) return;

    const deletedSessionId = extractDeletedSessionId(payload);
    if (deletedSessionId) {
      if (!queues.has(deletedSessionId)) return;
      setQueueItems(deletedSessionId, directories.get(deletedSessionId), []);
      clearTimer(deletedSessionId);
      failures.delete(deletedSessionId);
      commit(deletedSessionId);
      directories.delete(deletedSessionId);
      return;
    }

    const moved = extractSessionDirectoryUpdate(payload);
    if (moved) {
      const queue = queues.get(moved.sessionId);
      if (queue && queue.directory !== moved.directory) {
        setQueueItems(moved.sessionId, moved.directory, queue.items);
        commit(moved.sessionId);
      }
      return;
    }

    const status = extractSessionStatus(payload);
    if (status) {
      if (!queues.has(status.sessionId)) return;
      if (status.type === 'idle') armDispatch(status.sessionId);
      else clearTimer(status.sessionId);
      return;
    }

    const abortedSessionId = extractAbortedSessionId(payload);
    if (abortedSessionId) {
      if (queues.has(abortedSessionId)) abortedAt.set(abortedSessionId, now());
      return;
    }

    const assistant = extractAssistantMessageUpdate(payload);
    if (assistant && queues.has(assistant.sessionId)) {
      if (assistant.completed && !timers.has(assistant.sessionId)) armDispatch(assistant.sessionId);
    }
  }).parse;

  const processEvent = (event: GlobalStreamEvent | null | undefined) => {
    for (const payload of event?.translated?.() ?? []) processPayload(payload);
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') reconcileAll();
    });
    void load()
      .then(async () => {
        if (queues.size > 0) console.log(`[message-queue] restored queues for ${queues.size} session(s)`);
        await deliveryHoldReady;
        await automation?.ready();
        reconcileAll();
      })
      .catch((error) => {
        console.warn('[message-queue] failed to load queue file:', error?.message ?? error);
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  const cancelScheduledTask = async (projectId: string, taskId: ScheduledTaskInput['id']) => {
    await load();
    for (const [sessionId, queue] of queues) {
      const items = queue.items.filter((item) => item.scheduledTask?.projectId !== projectId || item.scheduledTask.taskId !== taskId || sending.get(sessionId) === item.id);
      if (items.length === queue.items.length) continue;
      setQueueItems(sessionId, queue.directory, items);
      commit(sessionId);
      armDispatch(sessionId);
    }
  };

  return {
    load,
    snapshot,
    sessionSnapshot,
    enqueue,
    cancelScheduledTask,
    remove,
    take,
    takeAll,
    reorder,
    clear,
    release,
    processPayload,
    start,
    stop,
    /** Stop admission first, then await active sends and their final persistence. */
    async drain() {
      while (dispatches.size) await Promise.all([...dispatches]);
      await writeResult;
    },
    /** Drains handled writes; admission and drain still propagate persistence failures. */
    flush: () => writePromise,
  };
}

export function registerMessageQueueRoutes(app: Application, runtime: ReturnType<typeof createMessageQueueRuntime>) {
  const respondError = (res: HttpResponse, cause: unknown, fallback: string) => {
    const statusValue = hasReadableFields(cause) ? cause.status : undefined;
    const status = cause instanceof TypeError ? 400 : (isInteger(statusValue) ? statusValue : 500);
    res.status(status).json({ error: (hasReadableFields(cause) ? cause.message : undefined) ?? fallback });
  };

  app.get('/api/message-queue', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load message queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items', async (req, res) => {
    try {
      const body = req.body;
      if (hasQueueBody(body) && hasScheduledTaskField(body.item) && body.item.scheduledTask) throw new TypeError('scheduledTask is server-owned');
      if (hasQueueBody(body) && hasScheduledTaskField(body.item) && body.item.origin !== undefined) throw new TypeError('origin is server-owned');
      if (hasQueueBody(body) && hasScheduledTaskField(body.item) && body.item.notice !== undefined) throw new TypeError('notice is server-owned');
      res.json(await runtime.enqueue(req.params.sessionId, hasQueueBody(body) ? body.directory : undefined, hasQueueBody(body) ? body.item : undefined));
    } catch (error) {
      respondError(res, error, 'Failed to queue message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/take', async (req, res) => {
    try {
      res.json(await runtime.takeAll(req.params.sessionId));
    } catch (error) {
      respondError(res, error, 'Failed to take queued messages');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/order', async (req, res) => {
    try {
      res.json(await runtime.reorder(req.params.sessionId, hasQueueBody(req.body) ? req.body.itemIds : undefined));
    } catch (error) {
      respondError(res, error, 'Failed to reorder queue');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await runtime.clear(req.params.sessionId));
    } catch (error) {
      respondError(res, error, 'Failed to clear queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/take', async (req, res) => {
    try {
      res.json(await runtime.take(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to take queued message');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId/items/:itemId', async (req, res) => {
    try {
      res.json(await runtime.remove(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to remove queued message');
    }
  });
}
