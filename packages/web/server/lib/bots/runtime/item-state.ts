import { runtimeError } from './errors.js';
import type { BotItem, BotItemState } from '../schema.js';
import type { createBotEvents } from '../events.js';
import type { createBotAttention } from '../attention.js';
import type { createBotStore } from '../store.js';

export const humanStates: ReadonlySet<BotItemState> = new Set(['needs-you', 'waiting-answer', 'in-review']);
type SessionTarget = { readonly projectId: string; readonly itemId: string };
type ItemStateOptions = {
  readonly store: Pick<ReturnType<typeof createBotStore>, 'read' | 'update'>;
  readonly attention: Pick<ReturnType<typeof createBotAttention>, 'sync'>;
  readonly events: Pick<ReturnType<typeof createBotEvents>, 'publish'>;
};

export const createRuntimeItemState = ({ store, attention, events }: ItemStateOptions) => {
  const sessionIndex = new Map<BotItem['sessions'][keyof BotItem['sessions']], SessionTarget>();
  const itemFor = async (projectId: string, itemId: string): Promise<BotItem> => {
    const item = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
    if (!item) throw runtimeError('BOT_ITEM_NOT_FOUND', 404);
    return item;
  };
  const mutate = async (projectId: string, itemId: string, change: (item: BotItem) => BotItem): Promise<BotItem> => {
    const snapshot = await store.update(projectId, (current) => ({ snapshot: { ...current, items: current.items.map((item) => item.id === itemId ? change(item) : item) } }));
    const item = snapshot.items.find((entry) => entry.id === itemId);
    if (!item) throw runtimeError('BOT_ITEM_NOT_FOUND', 404);
    for (const sessionId of Object.values(item.sessions)) sessionIndex.set(sessionId, { projectId, itemId });
    await attention.sync({ projectId, item });
    events.publish({ type: 'bot.item.changed', projectId, item });
    return item;
  };
  const transition = (projectId: string, itemId: string, state: BotItemState, patch: Readonly<Partial<BotItem>> = {}) => mutate(projectId, itemId, (item) => {
    const next = { ...item, ...patch, state };
    if (!humanStates.has(state)) delete next.wait;
    return next;
  });
  return { itemFor, mutate, transition, sessionIndex };
};
