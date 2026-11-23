import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { BotServiceError } from './services/contracts.js';
import type { BotItem } from './schema.js';
import type { BotExecutionEntry, createBotExecutionStore } from './execution-store.js';

type PlacementKey = { readonly projectId: string; readonly itemId: string };
type PlacementRequest = PlacementKey & {
  readonly bot: { readonly id: string; readonly isolated?: boolean };
  readonly directory: string; readonly sessionId?: string;
  readonly sessions?: BotItem['sessions']; readonly capturedRun?: unknown;
};
type PlacementBinding = {
  readonly botId: string; readonly hostDirectory: string; readonly directory?: string | undefined;
  readonly spaceId?: string | undefined; readonly state: string;
  readonly sessions: Readonly<Record<string, { readonly id: string; readonly stage: keyof BotItem['sessions']; readonly directory: string }>>;
};
type PlacementOptions = {
  readonly dataDir: string;
  readonly journal: Pick<ReturnType<typeof createBotExecutionStore>, 'read'>;
  readonly isolated: { readBinding(key: PlacementKey): Promise<PlacementBinding | null> };
  readonly getSpaceArchive?: (() => { sessionDirectory(spaceId: string | undefined, sessionId: string): string | null } | null) | undefined;
};

const text = z.string().min(1);
const placementSchema = z.object({ version: z.literal(1), projectId: text, itemId: text,
  botId: text, hostDirectory: text, isolated: z.boolean() }).strict();
const runSchema = z.object({ projectId: text, itemId: text, directory: text,
  stage: z.enum(['investigation', 'fixing', 'judge']), dispatchedAt: z.number(),
  bot: z.object({ id: text, isolated: z.boolean() }) });
const refuse: () => never = () => { throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'Repair the recorded execution placement before resuming this item.'); };

export function createBotPlacement({ dataDir, journal, isolated, getSpaceArchive = () => null }: PlacementOptions) {
  const records = createBotAdapterState({ dataDir, name: 'placements', schema: placementSchema });
  const resolve = async ({ projectId, itemId, bot, directory, sessionId, sessions = {}, capturedRun }: PlacementRequest): Promise<z.output<typeof placementSchema>> => {
    const key = { projectId, itemId };
    return records.own(key, async () => {
      const previous = await records.read(key);
      if (previous) {
        if (previous.botId !== bot.id || previous.hostDirectory !== directory) refuse();
        return previous;
      }
      const binding = await isolated.readBinding(key);
      const execution = await journal.read(projectId, itemId);
      const runs = Object.values(execution.data.runs ?? {}).map((entry: BotExecutionEntry['data'][string]) => runSchema.parse(entry));
      if (capturedRun) runs.push(runSchema.parse(capturedRun));
      runs.sort((left, right) => left.dispatchedAt - right.dispatchedAt);
      const first = runs[0];
      if (!binding && !first && (sessionId || Object.keys(sessions).length)) refuse();
      if (first && (first.projectId !== projectId || first.itemId !== itemId || first.bot.id !== bot.id || first.directory !== directory)) refuse();
      if (binding && (binding.botId !== bot.id || binding.hostDirectory !== directory || first && !first.bot.isolated)) refuse();
      return records.write(key, { version: 1, ...key, botId: bot.id, hostDirectory: directory,
        isolated: binding ? true : first ? first.bot.isolated : bot.isolated });
    });
  };
  const sessionDirectories = async ({ projectId, item }: {
    readonly projectId: string; readonly item: Pick<BotItem, 'id' | 'botId' | 'sessions' | 'worktree'>;
  }): Promise<Record<string, string>> => {
    if (!Object.keys(item.sessions).length || !item.worktree) return {};
    const placement = await resolve({ projectId, itemId: item.id, bot: { id: item.botId }, directory: item.worktree, sessions: item.sessions });
    if (!placement.isolated) return Object.fromEntries(Object.values(item.sessions).map((id) => [id, placement.hostDirectory]));
    const binding = await isolated.readBinding({ projectId, itemId: item.id });
    if (!binding || binding.botId !== item.botId || binding.hostDirectory !== placement.hostDirectory) refuse();
    return Object.fromEntries(Object.entries(item.sessions).flatMap(([stage, id]) => {
      const session = Object.values(binding.sessions).find((entry) => entry.id === id && entry.stage === stage);
      if (!session || session.directory !== binding.directory) return [];
      const directory = binding.state === 'removed' ? getSpaceArchive()?.sessionDirectory(binding.spaceId, session.id) : session.directory;
      return directory ? [[id, directory]] : [];
    }));
  };
  return { resolve, sessionDirectories, read: records.read };
}
