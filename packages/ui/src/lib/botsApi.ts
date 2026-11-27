import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getBotsRuntime } from './botsRuntime';
import { botDefinitionSchema, botDefinitionsSchema, botsConfigSchema, type BotDefinition, type BotsConfig } from './bots/config';
import { botConversationSchema, botItemSchema, botPullRequestSchema, botWaitSchema, type BotEvidence, type BotSource } from './bots/items';
import { botIdentitySchema, botPolicySchema, type BotIdentityInput } from './bots/management';

const snapshotSchema = z.object({
  config: botsConfigSchema, revision: z.number().int().nonnegative(), items: z.array(botItemSchema),
  presets: z.array(botDefinitionSchema),
});
const itemDetailSchema = z.object({
  item: botItemSchema, reports: z.record(z.string(), z.json()),
  sessionDirectories: z.record(z.string(), z.string().min(1)).default({}),
  questionKey: z.string().min(1).optional(),
  snapshot: z.object({ baseSha: z.string(), headSha: z.string(), diff: z.string(), changes: z.array(z.object({ oldPath: z.string().nullable().optional(), newPath: z.string().nullable().optional() })) }).nullable(),
});
export type BotsSnapshot = z.infer<typeof snapshotSchema>;
export type BotItemDetailRead = z.infer<typeof itemDetailSchema>;

export class BotsApiError extends Error {
  readonly name = 'BotsApiError';
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const errorSchema = z.object({ code: z.string().optional(), error: z.string().optional() });

/** Parse every response here. No response body from credential writes is echoed into UI errors. */
async function request<T>(path: string, schema: z.ZodType<T>, options?: { readonly body?: string; readonly method?: string; readonly signal?: AbortSignal }): Promise<T> {
  if (isVSCodeRuntime()) throw new BotsApiError(501, 'bots_unsupported');
  const runtime = getBotsRuntime();
  const signal = options?.signal ? AbortSignal.any([runtime.signal, options.signal]) : runtime.signal;
  const init: RequestInit = {
    method: options?.method ?? 'GET', signal,
  };
  if (options?.body !== undefined) {
    init.body = options.body;
    init.headers = { 'Content-Type': 'application/json' };
  }
  const response = await runtimeFetch(path, init);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(await response.json().catch(() => null));
    throw new BotsApiError(response.status, parsed.success ? parsed.data.code ?? `http_${response.status}` : `http_${response.status}`);
  }
  const result = schema.parse(await response.json());
  signal.throwIfAborted();
  return result;
}
const root = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/bots`;

const botWorkItemSchema = botItemSchema.pick({ title: true, state: true, source: true, sessions: true }).extend({
  projectId: z.string().min(1), itemId: z.string().min(1), wait: botWaitSchema.nullable(),
  question: z.object({ questionKey: z.string().min(1), questions: z.array(z.string()) }).nullable(),
  conversation: botConversationSchema.nullable(),
  worktree: z.string().min(1).nullable(), pr: botPullRequestSchema.nullable(), tokens: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative().nullable(),
  takenOver: z.object({ sessionId: z.string().min(1), at: z.number().int().nonnegative() }).nullable(),
});
const botChatsSchema = z.object({
  main: botConversationSchema.nullable(),
  projects: z.array(z.object({ projectId: z.string().min(1), access: z.enum(['read', 'pr', 'merge']) })),
  items: z.array(botWorkItemSchema),
  available: z.object({ mainChat: z.boolean(), takeOver: z.boolean() }).default({ mainChat: true, takeOver: true }),
});
export type BotWorkItem = z.infer<typeof botWorkItemSchema>;
export type BotChats = z.infer<typeof botChatsSchema>;

export const fetchBotDefinitions = () => request('/api/bots', botDefinitionsSchema);
export const saveBotDefinitions = (definitions: readonly BotDefinition[], expectedRevision: number) => request('/api/bots', botDefinitionsSchema, {
  method: 'PUT', body: JSON.stringify({ definitions: definitions.map((bot) => botDefinitionSchema.parse(bot)), expectedRevision }),
});
export const fetchBotChats = (botId: string) => request(`/api/bots/${encodeURIComponent(botId)}/chats`, botChatsSchema);
export const ensureBotMainChat = (botId: string) => request(`/api/bots/${encodeURIComponent(botId)}/main`, z.object({ session: botConversationSchema }), { method: 'POST' });
export const takeOverBotItem = (projectId: string, itemId: string) => request(`${root(projectId)}/items/${encodeURIComponent(itemId)}/take-over`,
  itemDetailSchema.extend({ session: z.object({ sessionId: z.string().min(1), directory: z.string().min(1) }).nullable() }), { method: 'POST' });

export const fetchBots = (projectId: string) => request(root(projectId), snapshotSchema);
export const saveBotsConfig = (projectId: string, config: BotsConfig) => request(`${root(projectId)}/config`, z.object({ config: botsConfigSchema }), {
  method: 'PUT', body: JSON.stringify({ config: botsConfigSchema.parse(config) }),
});
export const runBot = (projectId: string, botId: string) => request(`${root(projectId)}/${encodeURIComponent(botId)}/run`, z.json(), { method: 'POST', body: '{}' });
export type CreateBotItem = { readonly botId: string; readonly source: BotSource; readonly title: string; readonly description?: string; readonly evidence?: readonly BotEvidence[] };
export const createBotItem = (projectId: string, input: CreateBotItem) => request(`${root(projectId)}/items`, z.object({ item: botItemSchema }), { method: 'POST', body: JSON.stringify(input) });
export const fetchBotItem = (projectId: string, itemId: string) => request(`${root(projectId)}/items/${encodeURIComponent(itemId)}`, itemDetailSchema);
export const ensureBotConversation = (projectId: string, itemId: string) => request(
  `${root(projectId)}/items/${encodeURIComponent(itemId)}/conversation`, z.object({ conversation: botConversationSchema }), { method: 'POST' },
);
type BotItemAction = { readonly kind: 'stop' | 'resume' }
  | { readonly kind: 'answer'; readonly text: string; readonly eventId: string; readonly questionKey?: string };
export const actOnBotItem = (projectId: string, itemId: string, action: BotItemAction) => request(
  `${root(projectId)}/items/${encodeURIComponent(itemId)}/${action.kind}`, z.json(),
  { method: 'POST', body: JSON.stringify(action.kind === 'answer' ? { text: action.text, eventId: action.eventId, questionKey: action.questionKey } : {}) },
);
export const fetchBotArchive = (projectId: string, month: string) => request(`${root(projectId)}/archive?month=${encodeURIComponent(month)}`, z.object({ items: z.array(botItemSchema) }));
export const fetchBotPolicy = (projectId: string) => request(`${root(projectId)}/policy`, botPolicySchema);
export const approveBotPolicy = (projectId: string, approval: { readonly file: string; readonly fingerprint: string }) => request(`${root(projectId)}/policy/approve`, z.json(), { method: 'POST', body: JSON.stringify(approval) });
export const fetchBotIdentities = (projectId: string) => request(`${root(projectId)}/identities`, z.object({ identities: z.array(botIdentitySchema) }));
export const writeBotIdentity = (projectId: string, input: BotIdentityInput, current?: { readonly id: string; readonly revision: number }) => request(
  `${root(projectId)}/identities${current ? `/${encodeURIComponent(current.id)}` : ''}`, z.object({ identity: botIdentitySchema }),
  { method: current ? 'PUT' : 'POST', body: JSON.stringify(current ? { definition: input, expectedRevision: current.revision } : input) },
);
export const deleteBotIdentity = (projectId: string, current: { readonly id: string; readonly revision: number }) => request(
  `${root(projectId)}/identities/${encodeURIComponent(current.id)}`, z.object({ removed: z.boolean() }),
  { method: 'DELETE', body: JSON.stringify({ expectedRevision: current.revision }) },
);
