import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './accounts.js';
import { isBoolean, isNumber, isPrimitiveString, isRecord } from '../shared/guards.js';
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue | undefined };
type StoredValue = JsonValue | undefined;
type Check<T extends StoredValue> = (value: StoredValue) => value is T;
type Checked<C> = C extends Check<infer T> ? T : never;
type Contract = Readonly<Record<string, Check<StoredValue>>>;
type Fields<C extends Contract> = {
  readonly [K in keyof C as undefined extends Checked<C[K]> ? never : K]: Checked<C[K]>;
} & {
  readonly [K in keyof C as undefined extends Checked<C[K]> ? K : never]?: Checked<C[K]>;
};

const record: Check<JsonObject> = (value): value is JsonObject => isRecord(value);
const string = (min = 1, max = Infinity, pattern?: RegExp) => (value: StoredValue): value is string => isPrimitiveString(value)
  && value.length >= min && value.length <= max && (!pattern || pattern.test(value));
const text = string();
const queueText = (value: StoredValue): value is string => text(value) && value.trim().length > 0;
const itemText = string(1, 100_000);
const bool = isBoolean;
const count = (value: StoredValue): value is number => isNumber(value) && Number.isSafeInteger(value) && value >= 0;
const positive = (value: StoredValue): value is number => count(value) && value > 0;
const optional = <T extends StoredValue>(check: Check<T>) => (value: StoredValue): value is T | undefined => value === undefined || check(value);
const nullable = <T extends JsonValue>(check: Check<T>) => (value: StoredValue): value is T | null => value === null || check(value);
const choice = <const T extends readonly (string | number | boolean)[]>(...values: T) => (value: StoredValue): value is T[number] => values.some((entry) => entry === value);
const array = <T extends JsonValue>(check: Check<T>, max = Infinity) => (value: StoredValue): value is readonly T[] => Array.isArray(value) && value.length <= max && value.every(check);
function fields<C extends Contract>(contract: C, strict?: true): Check<Fields<C>>;
function fields<C extends Contract>(contract: C, strict: false): Check<Fields<C> & JsonObject>;
function fields(contract: Contract, strict = true): Check<JsonObject> {
  return (value: StoredValue): value is JsonObject => record(value)
    && Object.entries(contract).every(([key, check]) => check(value[key]))
    && (!strict || Object.keys(value).every((key) => Object.hasOwn(contract, key)));
}
const dictionary = <T extends JsonValue>(check: Check<T>, keyCheck = text) => (value: StoredValue): value is Readonly<Record<string, T>> => record(value)
  && Object.entries(value).every(([key, item]) => keyCheck(key) && check(item));
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const refine = <T extends StoredValue>(check: Check<T>, accepts: (value: T) => boolean) => (value: StoredValue): value is T => check(value) && accepts(value);
const read = <T extends StoredValue>(check: Check<T>, value: StoredValue): T => {
  if (!check(value)) fail('migration_bots_malformed', 'Invalid version-1 Bots migration record');
  return value;
};
const sha = string(40, 40, /^[a-f0-9]{40}$/);
const digest = string(64, 64, /^[a-f0-9]{64}$/);
const plainText = (max: number) => refine(string(1, max), (value) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
});
const serviceText = plainText(512);
const branch = (value: StoredValue): value is string => string(1, 200, /^[A-Za-z0-9][A-Za-z0-9_./-]*$/)(value)
  && !value.includes('..') && !value.includes('//') && !/[/.]$/.test(value)
  && value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
const stage = choice('investigation', 'fixing', 'judge');
const states = choice('queued', 'investigating', 'waiting-answer', 'fixing', 'proving', 'judging', 'in-review', 'merging', 'closing', 'done', 'needs-you', 'failed', 'stopped');
const actor = fields({ pid: positive, host: itemText });
const receipt = fields({ id: itemText, url: optional(itemText), sha: optional(itemText), sessionId: optional(itemText) });
const authority = fields({ service: choice('local', 'opencode', 'git', 'github', 'jira', 'discord'), identityId: itemText,
  revision: (value: StoredValue) => itemText(value) || count(value), target: itemText });
const effectBase = { key: itemText, kind: choice('session.create', 'session.prompt', 'worktree.create', 'worktree.remove', 'git.push', 'pr.open', 'pr.comment',
  'pr.auto-merge', 'pr.disable-auto-merge', 'pr.dequeue', 'pr.merge', 'jira.comment', 'jira.question', 'jira.transition', 'discord.send', 'discord.question'),
  inputDigest: digest, authority, createdAt: count, updatedAt: count };
const effectState = choice('prepared', 'dispatching', 'succeeded', 'refused', 'outcome-unknown');
const effects = { prepared: fields({ ...effectBase, state: choice('prepared') }),
  dispatching: fields({ ...effectBase, state: choice('dispatching'), owner: actor }),
  succeeded: fields({ ...effectBase, state: choice('succeeded'), receipt }),
  refused: fields({ ...effectBase, state: choice('refused'), code: itemText }),
  'outcome-unknown': fields({ ...effectBase, state: choice('outcome-unknown'), code: itemText }),
};
const effect = (value: StoredValue): value is Checked<(typeof effects)[keyof typeof effects]> => record(value)
  && effectState(value['state']) && effects[value['state']](value);
const integer = (value: StoredValue): value is number => isNumber(value) && Number.isSafeInteger(value);
const proof = (value: StoredValue) => fields({ status: choice('absent'), reason: itemText })(value)
  || fields({ status: choice('passed', 'failed', 'inconclusive'), testSha: itemText, fixSha: itemText, command: itemText, args: array(string(0)),
    testExitCode: nullable(integer), fixExitCode: nullable(integer), reason: optional(itemText) })(value);
const item = fields({ id: itemText, botId: itemText, source: fields({ kind: choice('manual', 'jira', 'suggestion', 'alert', 'investigation'), id: itemText, url: optional(itemText) }),
  title: itemText, description: optional(string(0, 100_000)), state: states, revision: count, createdAt: count, updatedAt: count, finishedAt: optional(count),
  owner: optional(nullable(actor)), worktree: optional(itemText), branch: optional(itemText), publicationBranch: optional(itemText),
  sessions: optional(fields({ investigation: optional(itemText), fixing: optional(itemText), judge: optional(itemText) })),
  pr: optional(fields({ number: positive, url: itemText, headSha: itemText, baseSha: optional(itemText) })),
  evidence: optional(array(fields({ source: itemText, summary: itemText, url: optional(itemText) }))), proof: optional(proof),
  judgment: optional(fields({ decision: choice('auto', 'review', 'ask'), reason: itemText, headSha: itemText, baseSha: itemText, policyFingerprint: itemText,
    reviewers: optional(array(itemText)), questions: optional(array(itemText)) })),
  wait: optional(fields({ reason: itemText, since: count, channel: choice('ui', 'jira', 'discord', 'github'), people: optional(array(itemText)) })),
  tokens: optional(fields({ total: count, byStage: fields({ investigation: count, fixing: count, judge: count }), byDay: dictionary(count, string(10, 10, /^\d{4}-\d{2}-\d{2}$/)) })),
  transitions: optional(array(fields({ from: nullable(states), to: states, at: count, revision: count, owner: actor, reason: itemText }))), effects: optional(array(effect)),
});
export const readBotItem = (value: StoredValue) => read(refine(item, (value) => unique((value.effects ?? []).map((entry) => entry.key))
  && (!['done', 'failed', 'stopped'].includes(value.state) || value.finishedAt !== undefined)), value);

const inode = string(1, Infinity, /^[0-9]+:[0-9]+$/);
const checkoutOwner = { version: choice(1), projectId: serviceText, projectPath: serviceText, itemId: serviceText, botId: serviceText,
  repositoryId: serviceText, key: serviceText, directory: serviceText, branch, baseBranch: branch, baseSha: sha,
  identityId: serviceText, identityRevision: positive, gitDirectory: optional(serviceText), gitIdentity: optional(inode), directoryIdentity: optional(inode) };
export const checkoutOwnerKeys = Object.keys(checkoutOwner);
const transferText = plainText(4096);
const absolute = (value: StoredValue): value is string => transferText(value) && path.isAbsolute(value);
const adoption = fields({ fromSha: sha, resultSha: sha, resultRef: string(1, Infinity, /^refs\/openchamber\/spaces\/[a-f0-9]{12}\/result$/),
  association: optional(fields({ spaceId: string(12, 12, /^[a-f0-9]{12}$/), source: fields({ kind: choice('bot-checkout'), projectDirectory: absolute,
    projectId: transferText, botId: transferText, itemId: transferText, checkoutKey: transferText }) })) });
export const readCheckout = (value: StoredValue) => read(refine(fields({ ...checkoutOwner, publicationBranch: optional(branch),
  state: choice('preparing', 'ready', 'adopting', 'removing', 'removed'), removeHead: optional(sha), adoption: optional(adoption) }),
  (value) => (value.state === 'adopting') === Boolean(value.adoption)), value);
export const readPublicationRegistry = (value: StoredValue) => read(fields({ version: choice(1), repositoryId: serviceText,
  reservations: array(fields({ publicationBranch: branch, owner: fields(checkoutOwner) })) }), value);
export const readBotWatchAuthority = (value: StoredValue) => read(fields({ project: fields({ id: text, path: text }), botId: text, itemId: text,
  identityId: text, identityRevision: positive, publicationBranch: optional(string(1, 200)),
  target: fields({ repositoryId: text, owner: text, repo: text }) }), value);
export const readPlacement = (value: StoredValue) => read(fields({ version: choice(1), projectId: serviceText, itemId: serviceText, botId: serviceText,
  hostDirectory: serviceText, isolated: bool }), value);
export const readRuns = (value: StoredValue) => read(dictionary(fields({ projectId: serviceText, itemId: serviceText, stage,
  directory: serviceText, dispatchedAt: (value: StoredValue): value is number => isNumber(value) && Number.isFinite(value),
  bot: fields({ id: serviceText, isolated: bool }, false) }, false)), value);
export const readQueueSnapshot = (value: StoredValue) => read(fields({ version: choice(1), revision: count,
  sessions: dictionary(fields({ directory: (value: StoredValue): value is string => queueText(value) && value === value.trim(), items: (items: StoredValue): items is readonly JsonValue[] => Array.isArray(items) }, false), string(4, 128, /^[A-Za-z0-9_-]+$/)) }, false), value);

const configText = (value: StoredValue): value is string => isPrimitiveString(value) && value.trim().length > 0 && value.trim().length <= 20_000;
const provider = string(1, 64, /^[A-Za-z0-9._-]+$/);
const modelEndpoint = (value: StoredValue): value is string => {
  if (!string(1, 2000)(value)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
};
const spaceGrant = (value: StoredValue) => fields({ kind: choice('login', 'custom'), provider })(value)
  || fields({ kind: choice('model'), provider, upstream: modelEndpoint,
    secret: fields({ kind: choice('env'), name: string(1, 256, /^[A-Za-z_][A-Za-z0-9_]*$/) }) })(value);
const space = fields({ placeId: optional(provider), network: optional(fields({ mode: choice('allowlist', 'open'),
  domains: optional(array(string(1, 253, /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/), 200)) })),
  grants: optional(refine(array(spaceGrant, 16), (value) => unique(value.map((grant) => grant.provider)))) });
const model = refine(fields({ useDefaults: optional(bool), providerID: optional(configText), modelID: optional(configText),
  variant: optional(configText), agent: optional(configText) }, false), (value) => value.useDefaults !== false || Boolean(value.providerID && value.modelID));
const mcp = array(fields({ server: configText, tools: dictionary(choice('allow', 'ask', 'deny'), configText) }, false));
const budget = nullable(refine(positive, (value) => value <= 100_000_000));
const clock = string(5, 5, /^([01]\d|2[0-3]):[0-5]\d$/);
const weekdays = array((value: StoredValue): value is number => isNumber(value) && Number.isInteger(value) && value >= 0 && value <= 6);
const snowflake = string(6, 25, /^[1-9][0-9]{5,24}$/);
const definition = fields({ id: string(1, Infinity, /^[A-Za-z0-9_-]+$/), name: configText, enabled: optional(bool), mission: configText,
  schedule: optional(refine(fields({ kind: optional(choice('manual', 'daily', 'weekly', 'cron')), time: optional(clock), weekdays: optional(weekdays),
    cron: optional(configText), timezone: optional(configText) }, false), (value) => value.kind !== 'weekly' || value.weekdays === undefined || value.weekdays.length > 0)),
  source: optional((value: StoredValue) => fields({ kind: choice('manual') }, false)(value)
    || fields({ kind: choice('jira'), jql: configText, maxItems: positive }, false)(value)
    || fields({ kind: choice('investigation'), prompt: configText, maxItems: positive }, false)(value)),
  models: optional(fields({ investigation: optional(model), fixing: optional(model), judge: optional(model) }, false)),
  mcp: optional(mcp), correctionMcp: optional(mcp), web: optional(bool), permissionMode: optional(choice('default', 'ask', 'safety', 'auto')),
  goalTokenBudget: optional(budget), notify: optional(choice('attention', 'finish')), isolated: optional(bool), space: optional(space),
  identity: optional(fields({ github: optional((value: StoredValue) => fields({ kind: choice('account'), accountId: configText }, false)(value)
    || fields({ kind: choice('app'), identityId: configText }, false)(value)), jira: optional(fields({ identityId: configText }, false)),
    discord: optional(fields({ identityId: configText }, false)) }, false)),
  limits: optional(fields({ dailyTokens: optional(budget), maxPendingHuman: optional(nullable(positive)) }, false)),
  proof: optional(fields({ command: configText, args: array(string(0, 20_000)) }, false)), jira: optional(fields({ doneTransition: optional(configText) }, false)),
  discord: optional(fields({ channels: optional(refine(array(fields({ guildId: snowflake, channelId: snowflake }), 100),
    (value) => unique(value.map((entry) => `${entry.guildId}/${entry.channelId}`)))) })),
}, false);
const config = refine(fields({ concurrency: optional(positive), retentionDays: optional(count), definitions: optional(array(definition)),
  approvals: optional(dictionary(digest)) }, false), (value) => unique((value.definitions ?? []).map((entry) => entry.id)));
export const isBotScheduledRow = (row: JsonObject | null | undefined) => Boolean(row?.['botId'] || row?.['botManaged']);
const taskSchedule = refine(fields({ kind: choice('daily', 'weekly', 'cron', 'once'), time: optional(clock), times: optional(refine(array(clock), (value) => value.length > 0)),
  weekdays: optional(refine(weekdays, (value) => value.length > 0)), cron: optional(text), date: optional(string(10, 10, /^\d{4}-\d{2}-\d{2}$/)), timezone: optional(text) }, false),
  (value) => {
    switch (value.kind) {
      case 'cron': return Boolean(value.cron);
      case 'once': return Boolean(value.date && value.time);
      case 'daily': return Boolean(value.time || value.times);
      case 'weekly': return Boolean((value.time || value.times) && value.weekdays);
      default: { const unreachable: never = value.kind; return unreachable; }
    }
  });
const botTask = refine(fields({ id: text, botId: string(1, Infinity, /^[A-Za-z0-9_-]+$/), botManaged: optional(choice(true)), name: text,
  enabled: bool, schedule: taskSchedule, execution: record, state: optional(record) }, false), (value) => !value['loopFile'] && !value['suggestedScan'] && !value['targetSessionId']);
export const validateOwnerBotsProject = (value: StoredValue) => read(refine(fields({ version: choice(1), bots: optional(config), scheduledTasks: optional(array(refine(fields({ id: text }, false),
  (row) => !isBotScheduledRow(row) || botTask(row)))) }, false), (value) => unique((value.scheduledTasks ?? []).map((row) => row.id))), value);

export function readQueuedItem(input: StoredValue) {
  const value = read(fields({ id: text, createdAt: count, content: string(0, 200_000), text: string(0),
    attachments: optional(array(fields({ id: optional(text), filename: queueText, mimeType: queueText, dataUrl: text, size: optional(count),
      source: optional(choice('local', 'server', 'vscode')), serverPath: optional(text), agentPath: optional(text) }, false))),
    context: optional(array((part: StoredValue) => fields({ kind: choice('context'), text: string(0), metadata: record, instructions: optional(text) }, false)(part)
      || fields({ kind: choice('instruction', 'synthetic'), text: string(0) }, false)(part))),
    sendConfig: optional(record), origin: optional(fields({ kind: choice('pr-fix-loop', 'pr-stack', 'bot'), id: queueText }, false)),
    scheduledTask: optional(fields({ projectId: queueText, taskId: queueText }, false)), goal: optional(fields({ tokenBudget: optional(nullable(positive)), objective: optional(text) }, false)),
  }, false), input);
  if (!value.text.trim() && !(value.attachments?.length || value.context?.length)) fail('migration_bots_malformed', 'Queued message has no deliverable content');
  const selection = value.sendConfig ?? {};
  if (!value.origin && !value.scheduledTask && !(queueText(selection['providerID']) && queueText(selection['modelID']))) fail('migration_bots_malformed', 'Queued message has no captured model');
  if (value.goal && !value.text.trim()) fail('migration_bots_malformed', 'Queued goal has no message text');
  if (value['notice'] !== undefined && value.origin?.kind !== 'bot' && value.origin?.kind !== 'pr-fix-loop') fail('migration_bots_malformed', 'Queued notice has no server origin');
  const origin = value.origin;
  if (origin?.kind === 'pr-fix-loop' && value['notice'] !== undefined) {
    read(refine(record, (notice) => notice['source'] === 'openchamber-notice' && notice['kind'] === 'fix-loop'
      && notice['loopId'] === origin.id && JSON.stringify(notice).length <= 64 * 1024), value['notice']);
  }
  if (value.origin?.kind !== 'bot') return value;
  if (value.scheduledTask || value.goal || value['agentMention'] || value.attachments?.length || value.context?.length || Object.keys(selection).length) {
    fail('migration_bots_malformed', 'Queued Bot notice must retain its text-only session selection');
  }
  const notice = read(fields({ source: choice('openchamber-notice'), kind: choice('bot'), projectId: text, itemId: text, eventId: text }), value['notice']);
  if (notice.itemId !== value.origin.id || Object.values(notice).some((entry) => entry !== entry.trim())
    || JSON.stringify(notice).length > 64 * 1024) fail('migration_bots_malformed', 'Invalid queued Bot notice identity');
  const hash = createHash('sha256').update(JSON.stringify([notice.projectId, notice.itemId, notice.eventId])).digest('hex');
  if (value.id !== `queued-bot-${hash}` || value['messageId'] !== `msg_${hash}`) fail('migration_bots_conflict', 'Queued Bot notice identity changed');
  return value;
}
