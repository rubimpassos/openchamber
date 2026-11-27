import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { botSpaceSchema } from './space-options.js';

const text = z.string().trim().min(1).max(20_000);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const tokens = positive.max(100_000_000).nullable().default(null);
const model = z.object({
  useDefaults: z.boolean().default(true),
  providerID: text.optional(), modelID: text.optional(), variant: text.optional(), agent: text.optional(),
}).refine((value) => value.useDefaults || Boolean(value.providerID && value.modelID), 'an explicit model needs providerID and modelID');
const mcp = z.array(z.object({ server: text, tools: z.record(text, z.enum(['allow', 'ask', 'deny'])) })).default([]);
const snowflake = z.string().regex(/^[1-9][0-9]{5,24}$/);
const avatar = z.string().max(32_768).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
  .pipe(z.string().refine((value) => {
    const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
    switch (value.slice(5, value.indexOf(';'))) {
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/webp':
      return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    default:
      return false;
    }
  }, 'The bot photo must be a PNG, JPEG or WebP thumbnail'));
export const botDiscordConfigSchema = z.object({
  channels: z.array(z.object({ guildId: snowflake, channelId: snowflake }).strict()).max(100).default([]),
}).strict().refine((value) => new Set(value.channels.map((channel) => `${channel.guildId}/${channel.channelId}`)).size === value.channels.length, 'Discord channels must be unique');
const schedule = z.object({
  kind: z.enum(['manual', 'daily', 'weekly', 'cron']).default('manual'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  weekdays: z.array(z.number().int().min(0).max(6)).default([1]),
  cron: text.default('0 9 * * 1-5'), timezone: text.optional(),
}).refine((value) => value.kind !== 'weekly' || value.weekdays.length > 0, 'weekly schedules need weekdays');

export const botDefinitionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/), name: text, enabled: z.boolean().default(true), mission: text,
  avatar: avatar.nullable().optional(),
  schedule: schedule.prefault({}),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('jira'), jql: text, maxItems: positive }),
    z.object({ kind: z.literal('investigation'), prompt: text, maxItems: positive }),
  ]).default({ kind: 'manual' }),
  models: z.object({ investigation: model.prefault({}), fixing: model.prefault({}), judge: model.prefault({}) }).prefault({}),
  mcp, correctionMcp: mcp, web: z.boolean().default(false),
  permissionMode: z.enum(['default', 'ask', 'safety', 'auto']).default('default'),
  goalTokenBudget: tokens, notify: z.enum(['attention', 'finish']).default('attention'), isolated: z.boolean().default(false),
  space: botSpaceSchema.optional(),
  identity: z.object({
    github: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('account'), accountId: text }),
      z.object({ kind: z.literal('app'), identityId: text }),
    ]).optional(),
    jira: z.object({ identityId: text }).optional(), discord: z.object({ identityId: text }).optional(),
  }).prefault({}),
  limits: z.object({ dailyTokens: tokens, maxPendingHuman: positive.nullable().default(null) }).prefault({}),
  proof: z.object({ command: text, args: z.array(z.string().max(20_000)) }).optional(),
  jira: z.object({ doneTransition: text.optional() }).optional(),
  discord: botDiscordConfigSchema.prefault({}),
  projects: z.record(z.string().min(1), z.enum(['read', 'pr', 'merge'])).default({}),
  artifacts: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), label: z.string().trim().min(1).max(500) }).strict())
    .max(20).default([]).refine((value) => new Set(value.map((entry) => entry.id)).size === value.length, 'artifact ids must be unique'),
});

const uniqueIds = (definitions: readonly { readonly id: string }[]) => new Set(definitions.map((bot) => bot.id)).size === definitions.length;
const settingsSchema = z.object({
  concurrency: positive.default(2), retentionDays: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(90),
});
const approvalsSchema = z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/));
const storedSchema = settingsSchema.extend({
  approvals: approvalsSchema.default({}),
  definitions: z.array(botDefinitionSchema).default([]).refine(uniqueIds, 'bot ids must be unique'),
});
export const botDefinitionsSchema = z.array(botDefinitionSchema).max(200).refine(uniqueIds, 'bot ids must be unique');
const globalSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  definitions: botDefinitionsSchema,
}).strict();

export type BotDefinition = z.output<typeof botDefinitionSchema>;
export type BotDefinitionInput = z.input<typeof botDefinitionSchema>;
export type BotAccess = BotDefinition['projects'][string];
type StoredProjectConfig = z.output<typeof storedSchema>;
export type BotsConfig = z.output<typeof settingsSchema> & { readonly approvals: Record<string, string>; readonly definitions: BotDefinition[] };
export type BotsConfigReadResult = { readonly ok: true; readonly config: StoredProjectConfig } | { readonly ok: false; readonly error: string };
export interface BotsProjectConfigRuntime {
  readBotsSection(projectId: string): Promise<unknown>;
  updateBotsSection(projectId: string, change: (raw: unknown) => StoredProjectConfig | Promise<StoredProjectConfig>): Promise<unknown>;
}

const projectEditSchema = settingsSchema.extend({
  definitions: z.array(botDefinitionSchema).refine(uniqueIds, 'bot ids must be unique').optional(),
});
export const parseConfigEdit = (raw: unknown) => projectEditSchema.parse(raw);
export const readBotsConfig = (raw: unknown): BotsConfigReadResult => {
  const result = storedSchema.safeParse(raw === undefined ? {} : raw);
  return result.success ? { ok: true, config: result.data } : { ok: false, error: result.error.message };
};

const requireConfig = (raw: unknown) => {
  const result = readBotsConfig(raw);
  if (!result.ok) throw new Error(`Invalid bots config: ${result.error}`);
  return result.config;
};
const projectSection = ({ concurrency, retentionDays, approvals, definitions }: StoredProjectConfig) => ({ concurrency, retentionDays, approvals, definitions });

type ConfigOptions = { readonly projectConfigRuntime: BotsProjectConfigRuntime; readonly dataDir: string; readonly fsImpl?: typeof fs };

export const createBotsConfig = ({ projectConfigRuntime, dataDir, fsImpl = fs }: ConfigOptions) => {
  const filePath = path.join(dataDir, 'bots', 'definitions.json');
  const readGlobal = async () => {
    try { return globalSchema.parse(JSON.parse(await fsImpl.readFile(filePath, 'utf8'))); }
    catch (failure) {
      if (failure instanceof Error && 'code' in failure && failure.code === 'ENOENT') return globalSchema.parse({ version: 1, revision: 0, definitions: [] });
      throw failure;
    }
  };
  const writeGlobal = async (value: z.input<typeof globalSchema>) => {
    const next = globalSchema.parse(value);
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await fsImpl.rename(temporary, filePath);
    } catch (failure) {
      await fsImpl.rm(temporary, { force: true });
      throw failure;
    }
    return next;
  };
  const withGlobal = <T>(operation: () => Promise<T>) => withSourceControlFileLock(`${filePath}.lock`, operation, { waitMs: 10_000 });

  const sameBot = (left: BotDefinition, right: BotDefinition) => {
    const { projects: _left, ...leftFields } = left;
    const { projects: _right, ...rightFields } = right;
    return JSON.stringify(leftFields) === JSON.stringify(rightFields);
  };
  const migrate = async (projectId: string, stored: StoredProjectConfig) => {
    if (!stored.definitions.length) return [];
    const { conflicting, moved } = await withGlobal(async () => {
      const current = await readGlobal();
      const definitions = [...current.definitions];
      const kept: BotDefinition[] = [];
      for (const legacy of stored.definitions) {
        const access = Object.keys(legacy.projects).length ? legacy.projects[projectId] : 'merge';
        const granted = access ? { [projectId]: access } : {};
        const index = definitions.findIndex((entry) => entry.id === legacy.id);
        const existing = index === -1 ? undefined : definitions[index];
        if (!existing) definitions.push({ ...legacy, projects: { ...legacy.projects, ...granted } });
        else if (existing.projects[projectId] !== undefined || sameBot(existing, legacy)) definitions[index] = { ...legacy, projects: { ...existing.projects, ...granted } };
        else kept.push({ ...legacy, projects: granted });
      }
      const changed = kept.length < stored.definitions.length;
      if (changed) await writeGlobal({ ...current, revision: current.revision + 1, definitions });
      return { conflicting: kept, moved: changed };
    });
    if (moved) await projectConfigRuntime.updateBotsSection(projectId, (raw) => ({ ...projectSection(requireConfig(raw)), definitions: conflicting }));
    return conflicting;
  };
  const readProject = async (projectId: string) => {
    const stored = requireConfig(await projectConfigRuntime.readBotsSection(projectId));
    return { ...stored, conflicting: await migrate(projectId, stored) };
  };

  const read = async (projectId: string): Promise<BotsConfig> => {
    const stored = await readProject(projectId);
    const { definitions } = await readGlobal();
    const scoped = definitions.filter((bot) => bot.projects[projectId] !== undefined && !stored.conflicting.some((kept) => kept.id === bot.id));
    const { concurrency, retentionDays, approvals } = stored;
    return { concurrency, retentionDays, approvals, definitions: [...scoped, ...stored.conflicting] };
  };
  return {
    read,
    update: async (projectId: string, input: unknown) => {
      const { definitions: listed, ...settings } = parseConfigEdit(input);
      await readProject(projectId);
      if (listed) await withGlobal(async () => {
        const current = await readGlobal();
        const accessFor = (bot: BotDefinition, existing?: BotDefinition) => bot.projects[projectId] ?? existing?.projects[projectId] ?? 'merge';
        const definitions = current.definitions.map((existing) => {
          const edited = listed.find((bot) => bot.id === existing.id);
          if (edited) return { ...edited, projects: { ...existing.projects, [projectId]: accessFor(edited, existing) } };
          const { [projectId]: _removed, ...projects } = existing.projects;
          return { ...existing, projects };
        });
        for (const bot of listed) if (!current.definitions.some((entry) => entry.id === bot.id)) definitions.push({ ...bot, projects: { ...bot.projects, [projectId]: accessFor(bot) } });
        await writeGlobal({ ...current, revision: current.revision + 1, definitions });
      });
      await projectConfigRuntime.updateBotsSection(projectId, (raw) => ({ ...projectSection(requireConfig(raw)), ...settings }));
      return read(projectId);
    },
    setApproval: async (projectId: string, file: string, fingerprint: string | null) => {
      z.string().regex(/^(?:\.agents\/areas\/[^/]+\.md|\.openchamber\/people\.json)$/).parse(file);
      if (fingerprint !== null) z.string().regex(/^[a-f0-9]{64}$/).parse(fingerprint);
      await readProject(projectId);
      return projectConfigRuntime.updateBotsSection(projectId, (raw) => {
        const config = requireConfig(raw);
        const approvals = { ...config.approvals };
        if (fingerprint === null) delete approvals[file];
        else approvals[file] = fingerprint;
        return { ...projectSection(config), approvals };
      });
    },
    // One unreadable project leaves its legacy bots unmigrated and never blocks the global list.
    readDefinitions: async (projectIds: readonly string[]) => {
      const unreadable: string[] = [];
      for (const projectId of projectIds) {
        try { await readProject(projectId); } catch { unreadable.push(projectId); }
      }
      const { revision, definitions } = await readGlobal();
      return { revision, definitions, unreadable };
    },
    saveDefinitions: async (edited: readonly z.input<typeof botDefinitionSchema>[], expectedRevision: number) => {
      const definitions = botDefinitionsSchema.parse(edited);
      return withGlobal(async () => {
        const current = await readGlobal();
        if (current.revision !== expectedRevision) throw Object.assign(new Error('Bot definitions changed'), { code: 'BOT_DEFINITIONS_CHANGED', statusCode: 409 });
        const next = await writeGlobal({ ...current, revision: current.revision + 1, definitions });
        return { revision: next.revision, definitions: next.definitions, previous: current.definitions };
      });
    },
  };
};
