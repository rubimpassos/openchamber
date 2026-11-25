import { z } from 'zod';
import { BotArtifactError, artifactBindingSchema } from './artifacts-contract.js';
import type { BotArtifactBinding } from './artifacts-contract.js';
import type { createBotStore } from './store.js';
import type { createBotExecutionStore } from './execution-store.js';
import type { createBotPlacement } from './placement.js';
import type { createBotIsolatedStages } from './isolated-stages.js';
import type { BotItem } from './schema.js';

type Scope = { readonly projectId: string; readonly itemId: string };
type Options = {
  readonly store: ReturnType<typeof createBotStore>;
  readonly journal: ReturnType<typeof createBotExecutionStore>;
  readonly placement: ReturnType<typeof createBotPlacement>;
  readonly isolated: Pick<ReturnType<typeof createBotIsolatedStages>, 'readBinding'>;
  readonly listProjects: () => Promise<readonly { readonly id: string }[]>;
  readonly resolveProject: (id: string) => Promise<{ readonly id: string; readonly path: string }>;
};
const runSchema = z.object({
  projectId: z.string(), itemId: z.string(), directory: z.string(),
  bot: z.object({ id: z.string() }), stage: z.enum(['investigation', 'fixing', 'judge']),
});

export function createBotArtifactBindings({ store, journal, placement, isolated, listProjects, resolveProject }: Options) {
  const index = new Map<string, Scope>();
  const itemFor = async ({ projectId, itemId }: Scope) => {
    const project = await resolveProject(projectId);
    if (project.id !== projectId) throw new BotArtifactError('BOT_ARTIFACT_BINDING_MISMATCH', 403);
    const item = (await store.read(projectId)).items.find((entry) => entry.id === itemId)
      ?? (await store.readArchive(projectId)).find((entry) => entry.id === itemId);
    if (!item) throw new BotArtifactError('BOT_ITEM_NOT_FOUND', 404);
    return { project, item };
  };
  const entries = async (scope: Scope, item: BotItem): Promise<BotArtifactBinding[]> => {
    const result: BotArtifactBinding[] = [];
    const add = (value: BotArtifactBinding) => { result.push(artifactBindingSchema.parse(value)); index.set(value.sessionId, scope); };
    if (item.conversation) add({ ...scope, botId: item.botId, sessionId: item.conversation.sessionId,
      directory: item.conversation.directory, producer: { role: 'conversation' } });
    const execution = await journal.read(scope.projectId, item.id);
    const captured = await isolated.readBinding(scope);
    if (captured) {
      if (captured.botId !== item.botId || captured.hostDirectory !== item.worktree) throw new BotArtifactError('BOT_ARTIFACT_BINDING_MISMATCH', 403);
      for (const session of Object.values(captured.sessions)) add({ ...scope, botId: item.botId, sessionId: session.id,
        directory: session.directory, producer: { role: 'stage', stage: session.stage } });
      return result;
    }
    for (const effect of item.effects) {
      if (effect.kind !== 'session.create' || effect.state !== 'succeeded' || !effect.receipt.sessionId) continue;
      const run = runSchema.parse(execution.operations[effect.key]);
      if (run.projectId !== scope.projectId || run.itemId !== item.id || run.bot.id !== item.botId
        || run.directory !== item.worktree) throw new BotArtifactError('BOT_ARTIFACT_BINDING_MISMATCH', 403);
      const recorded = await placement.resolve({ ...scope, bot: { id: item.botId }, directory: run.directory, capturedRun: execution.operations[effect.key] });
      if (recorded.isolated) throw new BotArtifactError('BOT_ARTIFACT_BINDING_REQUIRED', 403);
      add({ ...scope, botId: item.botId, sessionId: effect.receipt.sessionId, directory: recorded.hostDirectory,
        producer: { role: 'stage', stage: run.stage } });
    }
    return result;
  };
  const forItem = async (scope: Scope) => entries(scope, (await itemFor(scope)).item);
  const list = async () => {
    const result: BotArtifactBinding[] = [];
    const failures: unknown[] = [];
    for (const project of await listProjects()) {
      try {
        for (const item of [...(await store.read(project.id)).items, ...await store.readArchive(project.id)]) {
          try { result.push(...await entries({ projectId: project.id, itemId: item.id }, item)); }
          catch (error) { failures.push(error); }
        }
      } catch (error) {
        failures.push(error);
      }
    }
    return { bindings: result, failures };
  };
  const resolve = async (sessionId: string) => {
    let scope = index.get(sessionId);
    if (!scope) {
      const { failures } = await list(); scope = index.get(sessionId);
      if (!scope && failures.length) throw new AggregateError(failures, 'Bot artifact binding inventory is incomplete');
    }
    if (!scope) return null;
    return (await forItem(scope)).find((entry) => entry.sessionId === sessionId) ?? null;
  };
  return { resolve, forItem, list, assertReadScope: async (scope: Scope) => { await itemFor(scope); } };
}
