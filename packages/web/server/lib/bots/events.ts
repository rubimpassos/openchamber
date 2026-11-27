import { EventEmitter } from 'node:events';
import type { BotDefinition } from './config.js';
import type { BotItem } from './schema.js';

export type BotEvent =
  | { readonly type: 'bot.item.changed'; readonly projectId: string; readonly item: BotItem }
  | { readonly type: 'bot.wake'; readonly projectId: string }
  | { readonly type: 'bot.config.changed'; readonly projectId: string }
  | { readonly type: 'bot.runtime.error'; readonly projectId: string; readonly code: string };

type BotTaskSchedule =
  | { kind: 'cron'; cron: string; timezone?: string }
  | { kind: 'daily'; times: string[]; timezone?: string }
  | { kind: 'weekly'; times: string[]; weekdays: number[]; timezone?: string };

/** In-process delivery only. Item snapshots remain the reconnect authority. */
export const createBotEvents = () => {
  const emitter = new EventEmitter<{ change: [BotEvent] }>();
  return {
    publish: (event: BotEvent) => emitter.emit('change', event),
    subscribe: (listener: (event: BotEvent) => void) => {
      emitter.on('change', listener);
      return () => emitter.off('change', listener);
    },
  };
};

export const botTaskFor = (bot: BotDefinition) => {
  const { kind, time, weekdays, cron, timezone } = bot.schedule;
  const schedule: BotTaskSchedule = kind === 'cron' ? { kind, cron } : kind === 'weekly'
    ? { kind, times: [time], weekdays } : { kind: 'daily', times: [time] };
  if (timezone) schedule.timezone = timezone;
  return {
    id: `bot-${bot.id}`, name: bot.name, botId: bot.id, botManaged: true as const,
    enabled: bot.enabled && kind !== 'manual', schedule,
    execution: { prompt: 'This task belongs to Bots. Dispatch it through the bot scheduler hook.', useDefaults: true as const, notify: bot.notify },
  };
};
