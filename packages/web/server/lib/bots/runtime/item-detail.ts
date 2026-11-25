import type { RuntimeContext, RuntimeDetailReader } from './context.js';
import type { createBotExecutionStore } from '../execution-store.js';
import { z } from 'zod';
import { runtimeError } from './errors.js';

export function createRuntimeItemDetail(context: RuntimeContext, journal: ReturnType<typeof createBotExecutionStore>): RuntimeDetailReader {
  return async (projectId, itemId) => {
    const project = await context.resolveProject(projectId);
    if (project.id !== projectId) throw runtimeError('BOT_PROJECT_MISMATCH');
    const item = (await context.store.read(projectId)).items.find((entry) => entry.id === itemId)
      ?? (await context.store.readArchive(projectId)).find((entry) => entry.id === itemId);
    if (!item) throw runtimeError('BOT_ITEM_NOT_FOUND', 404);
    const execution = await journal.read(projectId, itemId);
    return { item, reports: execution.data.outcomes ?? {}, snapshot: execution.data.snapshot ?? null,
      questionKey: z.string().nullish().parse(execution.data.pendingQuestion) ?? undefined };
  };
}
