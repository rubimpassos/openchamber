import React from 'react';
import { actOnBotItem, BotsApiError, fetchBotChats, fetchBotDefinitions, takeOverBotItem, type BotWorkItem } from '@/lib/botsApi';
import { getBotsRuntime } from '@/lib/botsRuntime';
import type { I18nKey } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useBotResource, useBotsRefresh } from '@/components/bots/useBotRequest';

const reasonKeys = {
  BOT_CONVERSATION_SCOPE_MISMATCH: 'bots.reason.BOT_CONVERSATION_SCOPE_MISMATCH',
  BOT_CONVERSATION_SESSION_MISMATCH: 'bots.reason.BOT_CONVERSATION_SESSION_MISMATCH',
  BOT_CONVERSATION_UNAVAILABLE: 'bots.reason.BOT_CONVERSATION_UNAVAILABLE',
  BOT_IDENTITY_REQUIRED: 'bots.reason.BOT_IDENTITY_REQUIRED',
  BOT_IDENTITY_UNAVAILABLE: 'bots.reason.BOT_IDENTITY_UNAVAILABLE',
  BOT_PROJECT_ACCESS_REQUIRED: 'bots.reason.BOT_PROJECT_ACCESS_REQUIRED',
  BOT_DAILY_TOKEN_BUDGET: 'bots.reason.BOT_DAILY_TOKEN_BUDGET',
  BOT_GOAL_TOKEN_BUDGET: 'bots.reason.BOT_GOAL_TOKEN_BUDGET',
  BOT_PENDING_HUMAN_LIMIT: 'bots.reason.BOT_PENDING_HUMAN_LIMIT',
  BOT_STOP_REQUESTED: 'bots.reason.BOT_STOP_REQUESTED',
  BOT_ARTIFACTS_MISSING: 'bots.reason.BOT_ARTIFACTS_MISSING',
  BOT_PUBLICATION_BRANCH_REQUIRED: 'bots.reason.BOT_PUBLICATION_BRANCH_REQUIRED',
  BOT_TOOL_OPERATION_PENDING: 'bots.reason.BOT_TOOL_OPERATION_PENDING',
  BOT_OPERATION_FAILED: 'bots.reason.BOT_OPERATION_FAILED',
  BOT_SESSION_ERROR: 'bots.reason.BOT_SESSION_ERROR',
  BOT_TOKEN_USAGE_UNAVAILABLE: 'bots.reason.BOT_TOKEN_USAGE_UNAVAILABLE',
  BOT_REMOTE_AUTHORIZATION_UNCONFIRMED: 'bots.reason.BOT_REMOTE_AUTHORIZATION_UNCONFIRMED',
  BOT_QUESTION_CHANGED: 'bots.reason.BOT_QUESTION_CHANGED',
} as const satisfies Record<string, I18nKey>;
const isExplainedReason = (code: string): code is keyof typeof reasonKeys => Object.hasOwn(reasonKeys, code);

export type BotReasonText = { readonly key: I18nKey; readonly params?: { readonly code: string } };

export function describeBotReason(reason: string): BotReasonText {
  const code = /^[A-Za-z0-9_]+$/.test(reason) ? reason : reason.match(/\bBOT_[A-Z0-9_]+\b/)?.[0];
  if (!code) return { key: 'bots.reason.unspecified' };
  return isExplainedReason(code) ? { key: reasonKeys[code] } : { key: 'bots.reason.unknown', params: { code } };
}

const actionFailureKey = (failure: BotsApiError): I18nKey => {
  if (failure.code === 'enterprise_mode') return 'bots.enterprise';
  return isExplainedReason(failure.code) ? reasonKeys[failure.code] : 'bots.panel.actionFailed';
};

export function useBotPanelData(botId: string) {
  const load = React.useCallback(async () => {
    const [chats, definitions] = await Promise.all([fetchBotChats(botId), fetchBotDefinitions()]);
    return { ...chats, bot: definitions.definitions.find((entry) => entry.id === botId) ?? null };
  }, [botId]);
  const read = useBotResource(load);
  const { refresh } = read;
  useBotsRefresh(null, refresh);
  return read;
}

export type BotPanelData = NonNullable<ReturnType<typeof useBotPanelData>['data']>;

type ItemRef = Pick<BotWorkItem, 'projectId' | 'itemId'>;
export const botWorkItemKey = (item: ItemRef): string => `${item.projectId}\n${item.itemId}`;

export function useBotItemActions(onSettled: () => void) {
  const [state, setState] = React.useState<{ readonly busy: boolean; readonly failure: { readonly item: string; readonly key: I18nKey } | null }>({ busy: false, failure: null });
  const mounted = React.useRef(true);
  const running = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (item: ItemRef, operation: (isCurrent: () => boolean) => Promise<I18nKey | null>) => {
    if (running.current) return;
    const runtime = getBotsRuntime();
    const isCurrent = () => mounted.current && !runtime.signal.aborted;
    running.current = true;
    setState({ busy: true, failure: null });
    let failed: I18nKey | null = null;
    try {
      failed = await operation(isCurrent);
    } catch (failure) {
      failed = failure instanceof BotsApiError ? actionFailureKey(failure) : 'bots.panel.actionFailed';
    } finally {
      running.current = false;
    }
    if (!isCurrent()) return;
    setState({ busy: false, failure: failed ? { item: botWorkItemKey(item), key: failed } : null });
    onSettled();
  };
  return {
    busy: state.busy,
    failureFor: (item: ItemRef): I18nKey | null => (state.failure?.item === botWorkItemKey(item) ? state.failure.key : null),
    resume: (item: ItemRef) => run(item, async () => { await actOnBotItem(item.projectId, item.itemId, { kind: 'resume' }); return null; }),
    stop: (item: ItemRef) => run(item, async () => { await actOnBotItem(item.projectId, item.itemId, { kind: 'stop' }); return null; }),
    takeOver: (item: ItemRef) => run(item, async (isCurrent) => {
      const { session } = await takeOverBotItem(item.projectId, item.itemId);
      if (!session) return 'bots.panel.takeOver.noSession';
      if (isCurrent()) useSessionUIStore.getState().setCurrentSession(session.sessionId, session.directory);
      return null;
    }),
  };
}
