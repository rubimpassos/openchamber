import { botItemSchema } from './schema.js';
import type { NotificationCenterRuntime } from '../notifications/center.js';

type BotAlert = {
  readonly kind: 'bot'; readonly priority: 'high'; readonly requestId: string;
  readonly action: { readonly type: 'bots'; readonly projectId: string; readonly itemId: string };
  readonly title: string; readonly body: string; readonly sessionId: string | null;
  readonly directory: string | null; readonly critical: boolean;
};
type AttentionOptions<NotifyResult> = {
  readonly center: Pick<NotificationCenterRuntime, 'upsertBot' | 'resolveBot'>;
  readonly notify: (payload: BotAlert) => NotifyResult | Promise<NotifyResult>;
};
type AttentionInput = { readonly projectId: string; readonly item: unknown; readonly critical?: boolean };

export function createBotAttention<NotifyResult>({ center, notify }: AttentionOptions<NotifyResult>) {
  if (!center?.upsertBot || !center?.resolveBot || !(notify instanceof Function)) {
    throw new Error('Bot attention requires a notification center and notify owner');
  }
  return {
    async sync({ projectId, item: candidate, critical = false }: AttentionInput) {
      const item = botItemSchema.parse(candidate);
      const target = { projectId, itemId: item.id };
      let result: Awaited<ReturnType<NotificationCenterRuntime['upsertBot']>> | null = null;
      if (item.state === 'needs-you' || item.state === 'waiting-answer') {
        result = await center.upsertBot({
          ...target, botState: item.state, title: item.title, body: item.wait?.reason ?? item.state,
          directory: item.worktree ?? null,
          sessionId: item.sessions.fixing ?? item.sessions.investigation ?? item.sessions.judge ?? null,
        });
      } else {
        await center.resolveBot(target);
      }
      if (critical || (item.state === 'needs-you' && result?.changed)) {
        await notify({
          kind: 'bot', priority: 'high', requestId: item.id,
          action: { type: 'bots', ...target },
          title: item.title, body: item.wait?.reason ?? item.state,
          sessionId: item.sessions.fixing ?? item.sessions.investigation ?? item.sessions.judge ?? null,
          directory: item.worktree ?? null, critical,
        });
      }
      return result?.entry ?? null;
    },
  };
}
