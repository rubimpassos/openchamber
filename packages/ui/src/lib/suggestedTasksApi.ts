import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';
import { getSuggestedTasksRuntime } from './suggestedTasksRuntime';

/**
 * Suggested tasks: per-project scans that propose work, and the inbox of what
 * they proposed. Server routes live in `packages/web/server/lib/suggested-tasks`.
 * Every answer is parsed here; a failed request throws, so a caller never
 * shows "no suggestions" for an inbox it could not read.
 */

const levels = ['low', 'medium', 'high'] as const;
const severities = ['low', 'medium', 'high', 'critical'] as const;
export const LENS_ACTIONS = ['suggest', 'todo', 'session', 'worktree', 'draft-pr'] as const;
export type LensAction = (typeof LENS_ACTIONS)[number];
export type SuggestionSeverity = (typeof severities)[number];
export const SUGGESTION_LEVELS = levels;
export const SUGGESTION_SEVERITIES = severities;

const lensModelSchema = z.object({
  useDefaults: z.boolean(),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  variant: z.string().optional(),
  agent: z.string().optional(),
});

const lensSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  preset: z.string().optional(),
  prompt: z.string(),
  model: lensModelSchema,
  web: z.boolean(),
  action: z.enum(LENS_ACTIONS),
});
export type SuggestedTaskLens = z.infer<typeof lensSchema>;

const configSchema = z.object({
  enabled: z.boolean(),
  schedule: z.object({
    kind: z.enum(['manual', 'daily', 'weekly', 'cron']),
    time: z.string(),
    weekdays: z.array(z.number()),
    cron: z.string(),
    timezone: z.string().optional(),
  }),
  quietHours: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }),
  scope: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
    baseBranch: z.string(),
    incremental: z.boolean(),
  }),
  limits: z.object({
    maxSuggestions: z.number(),
    tokenBudget: z.number().nullable(),
    minConfidence: z.enum(levels),
    minSeverity: z.enum(severities),
  }),
  dedupe: z.object({ dismissed: z.boolean(), todos: z.boolean() }),
  notify: z.boolean(),
  archiveScanSessions: z.boolean(),
  lenses: z.array(lensSchema),
});
export type SuggestedTasksConfig = z.infer<typeof configSchema>;

const repoLensSchema = z.object({
  id: z.string(),
  file: z.string(),
  status: z.enum(['enabled', 'disabled', 'changed', 'invalid']),
  error: z.string().optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  model: lensModelSchema.optional(),
  web: z.boolean().optional(),
  action: z.enum(LENS_ACTIONS).optional(),
});
export type RepositoryLens = z.infer<typeof repoLensSchema>;

const presetSchema = z.object({ id: z.string(), web: z.boolean(), prompt: z.string() });
export type LensPreset = z.infer<typeof presetSchema>;

const settingsSchema = z.object({
  config: configSchema,
  repoLenses: z.array(repoLensSchema),
  presets: z.array(presetSchema),
  nextRunAt: z.number().nullable(),
});
export type SuggestedTasksSettings = z.infer<typeof settingsSchema>;

const fileSchema = z.object({ path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() });
export type SuggestionFile = z.infer<typeof fileSchema>;

const conversionSchema = z.object({
  kind: z.enum(['session', 'worktree', 'draft-pr', 'todo', 'issue', 'draft']),
  auto: z.boolean().optional(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  todoId: z.string().optional(),
  url: z.string().optional(),
});

const suggestionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  lensId: z.string(),
  lensName: z.string(),
  title: z.string(),
  body: z.string(),
  files: z.array(fileSchema),
  confidence: z.enum(levels),
  severity: z.enum(severities),
  createdAt: z.number(),
  status: z.enum(['open', 'snoozed', 'dismissed', 'approved']),
  snoozedUntil: z.number().optional(),
  dismissedAt: z.number().optional(),
  dismissReason: z.string().optional(),
  approvedAt: z.number().optional(),
  conversion: conversionSchema.optional(),
  conversionPending: z.boolean().optional(),
  conversionRecoverable: z.boolean().optional(),
  conversionError: z.string().optional(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

const lensRunSchema = z.object({
  lensId: z.string(),
  lensName: z.string(),
  action: z.enum(LENS_ACTIONS),
  status: z.enum(['pending', 'running', 'done', 'failed', 'stopped']),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  error: z.string().optional(),
  reported: z.number(),
  added: z.number(),
  tokens: z.number(),
});
export type LensRun = z.infer<typeof lensRunSchema>;

const runSchema = z.object({
  id: z.string(),
  reason: z.enum(['manual', 'scheduled']),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  status: z.enum(['running', 'done', 'partial', 'failed', 'skipped']),
  skipped: z.enum(['quiet-hours', 'no-changes', 'no-lenses', 'disabled']).optional(),
  error: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  branch: z.string().optional(),
  changedFiles: z.number().optional(),
  lenses: z.array(lensRunSchema),
});
export type ScanRun = z.infer<typeof runSchema>;

const ISSUE_PROVIDERS = ['github', 'gitlab', 'linear'] as const;
export type IssueProvider = (typeof ISSUE_PROVIDERS)[number];

const inboxSchema = z.object({
  suggestions: z.array(suggestionSchema),
  runs: z.array(runSchema),
  issueProviders: z.array(z.enum(ISSUE_PROVIDERS)),
});
export type SuggestionInbox = z.infer<typeof inboxSchema>;

const summarySchema = z.object({
  projects: z.array(z.object({
    projectId: z.string(),
    open: z.number().optional(),
    running: z.boolean().optional(),
    error: z.boolean().optional(),
  })),
});
export type SuggestionSummary = z.infer<typeof summarySchema>['projects'];

const suggestionResponseSchema = z.object({ suggestion: suggestionSchema });
const errorBodySchema = z.object({ error: z.string() });

export type ApproveAction = 'session' | 'worktree' | 'draft-pr' | 'todo' | 'issue' | 'draft';

const basePath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/suggested-tasks`;

const request = async <T>(schema: z.ZodType<T>, path: string, init?: { method: string; body?: string }): Promise<T> => {
  const { signal } = getSuggestedTasksRuntime();
  signal.throwIfAborted();
  const response = await runtimeFetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) {
    throw new Error(errorBodySchema.safeParse(body).data?.error ?? `Request failed (${response.status})`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('Unexpected answer from the server');
  return parsed.data;
};

type PostBody = Partial<{
  action: ApproveAction;
  provider: IssueProvider;
  reason: string;
  until: number;
  file: string;
  enabled: boolean;
  lensIds: string[];
}>;

const post = <T>(schema: z.ZodType<T>, path: string, body: PostBody = {}) => request(schema, path, { method: 'POST', body: JSON.stringify(body) });

export const fetchSuggestionInbox = (projectId: string) => request(inboxSchema, basePath(projectId));

export const fetchSuggestionSummary = async (): Promise<SuggestionSummary> => (
  await request(summarySchema, '/api/openchamber/suggested-tasks/summary')
).projects;

export const fetchSuggestedTasksSettings = (projectId: string) => request(settingsSchema, `${basePath(projectId)}/settings`);

export const saveSuggestedTasksConfig = (projectId: string, config: SuggestedTasksConfig) => request(
  settingsSchema,
  `${basePath(projectId)}/settings`,
  { method: 'PUT', body: JSON.stringify({ config }) },
);

export const setRepositoryLensEnabled = (projectId: string, file: string, enabled: boolean) => (
  post(settingsSchema, `${basePath(projectId)}/repo-lenses`, { file, enabled })
);

export const runSuggestionScan = (projectId: string, lensIds?: string[]) => (
  post(inboxSchema, `${basePath(projectId)}/run`, lensIds ? { lensIds } : {})
);

export const stopSuggestionScan = (projectId: string, runId: string) => (
  post(z.object({ ok: z.boolean() }), `${basePath(projectId)}/runs/${encodeURIComponent(runId)}/stop`)
);

const itemPath = (projectId: string, suggestionId: string, action: string) => `${basePath(projectId)}/items/${encodeURIComponent(suggestionId)}/${action}`;

export const approveSuggestion = async (projectId: string, suggestionId: string, action: ApproveAction, provider?: IssueProvider) => (
  await post(suggestionResponseSchema, itemPath(projectId, suggestionId, 'approve'), provider ? { action, provider } : { action })
).suggestion;

export const dismissSuggestion = async (projectId: string, suggestionId: string, reason: string) => (
  await post(suggestionResponseSchema, itemPath(projectId, suggestionId, 'dismiss'), { reason })
).suggestion;

export const snoozeSuggestion = async (projectId: string, suggestionId: string, until: number) => (
  await post(suggestionResponseSchema, itemPath(projectId, suggestionId, 'snooze'), { until })
).suggestion;

export const restoreSuggestion = async (projectId: string, suggestionId: string) => (
  await post(suggestionResponseSchema, itemPath(projectId, suggestionId, 'restore'))
).suggestion;
