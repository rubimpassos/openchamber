import { z } from 'zod';
import { text } from './input-contracts.js';
import { runtimeError as error } from './errors.js';
import type { BotItem } from '../schema.js';
import type { JsonValue } from '../../shared/json-values.js';
import type { RuntimeContext } from './context.js';
import type { createRuntimeFeedback } from './feedback.js';

const operationId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const answerInput = z.object({ operationId, questionKey: text, text }).strict();
const scopedAnswerInput = answerInput.extend({ projectId: text, itemId: text }).strict();
const startInput = z.object({ operationId, projectId: text, title: text, description: z.string().max(100_000).optional() }).strict();

const parse = <Schema extends z.ZodType>(schema: Schema, input: JsonValue): z.output<Schema> => {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(error('BOT_TOOL_INPUT_INVALID', 400), { state: 'refused' });
  return result.data;
};

type Admit = (projectId: string, botId: string, candidate: { readonly source: BotItem['source']; readonly title: string; readonly description?: string }) => Promise<BotItem>;

export function createRuntimeBotWork({ config, store, journal, listProjects }: RuntimeContext,
  { answer, admit, pump }: { readonly answer: ReturnType<typeof createRuntimeFeedback>['answer']; readonly admit: Admit; readonly pump: (projectId: string) => Promise<void> }) {
  const work = async (botId: string) => {
    const projects: { readonly projectId: string; readonly access: string }[] = [];
    const items = [];
    const unreadable: string[] = [];
    const readProject = async (projectId: string) => {
      const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === botId);
      return { access: bot?.projects[projectId], items: (await store.read(projectId)).items.filter((entry) => entry.botId === botId) };
    };
    for (const project of await listProjects()) {
      let read;
      try { read = await readProject(project.id); } catch { unreadable.push(project.id); continue; }
      if (read.access) projects.push({ projectId: project.id, access: read.access });
      for (const item of read.items) {
        const data = (await journal.read(project.id, item.id)).data;
        const pending = data.pendingQuestion ? data.questions?.[data.pendingQuestion] : undefined;
        items.push({ projectId: project.id, itemId: item.id, title: item.title, state: item.state, source: item.source,
          wait: item.wait ?? null, question: pending ? { questionKey: data.pendingQuestion, questions: pending.input.questions } : null,
          conversation: item.conversation ?? null, sessions: item.sessions, worktree: item.worktree ?? null,
          pr: item.pr ?? null, tokens: item.tokens.total, updatedAt: item.updatedAt, finishedAt: item.finishedAt ?? null,
          takenOver: data.takenOver ?? null });
      }
    }
    return { projects, items: items.sort((left, right) => right.updatedAt - left.updatedAt), unreadable };
  };
  const relay = async (projectId: string, itemId: string, input: z.output<typeof answerInput>) => {
    const { item } = await answer(projectId, itemId, { text: input.text, eventId: `session:${input.operationId}` }, { explicit: true, questionKey: input.questionKey });
    return { item: { id: item.id, state: item.state } };
  };
  return {
    work,
    answerFromConversation: (projectId: string, itemId: string, input: JsonValue) => relay(projectId, itemId, parse(answerInput, input)),
    async handleMainTool({ botId, action, input }: { readonly botId: string; readonly action: string; readonly input: JsonValue }) {
      if (action === 'bot.items') return work(botId);
      if (action === 'item.answer') {
        const { projectId, itemId, ...answered } = parse(scopedAnswerInput, input);
        const item = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
        if (item?.botId !== botId) throw error('BOT_ITEM_NOT_FOUND', 404);
        return relay(projectId, itemId, answered);
      }
      if (action === 'bot.start') {
        const request = parse(startInput, input);
        const candidate: Parameters<Admit>[2] = { source: { kind: 'manual', id: `chat:${request.operationId}` }, title: request.title };
        const item = await admit(request.projectId, botId, request.description ? { ...candidate, description: request.description } : candidate);
        await pump(request.projectId);
        return { item: { projectId: request.projectId, id: item.id, state: item.state, conversation: item.conversation ?? null } };
      }
      throw error('BOT_ACTION_UNSUPPORTED', 400);
    },
  };
}
