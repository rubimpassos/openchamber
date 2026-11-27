import React from 'react';
import { toast } from '@/components/ui';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { BotsApiError, ensureBotMainChat, fetchBotChats, fetchBotDefinitions, type BotChats, type BotWorkItem } from '@/lib/botsApi';
import type { BotDefinition } from '@/lib/bots/config';
import { getBotsRuntime, useBotsRuntime } from '@/lib/botsRuntime';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export type BotSidebarEntry = {
  readonly bot: Pick<BotDefinition, 'id' | 'name' | 'avatar'>;
  readonly chats: BotChats | null;
};

export type BotsSidebarModel = {
  readonly present: boolean;
  readonly bots: readonly BotSidebarEntry[];
  readonly failed: boolean;
  readonly refresh: () => void;
};

export type BotChatTarget = { readonly sessionId: string; readonly directory: string | null };

type BotsRead = { readonly state: 'pending' | 'unsupported' | 'ready'; readonly bots: readonly BotSidebarEntry[] };
const PENDING: BotsRead & { readonly failed: boolean } = { state: 'pending', bots: [], failed: false };

const isUnsupported = (failure: BotsApiError): boolean => (failure.status === 501 || failure.status === 404 || failure.code === 'bots_unsupported');

async function readBots(): Promise<BotsRead> {
  let definitions: readonly BotDefinition[];
  try {
    definitions = (await fetchBotDefinitions()).definitions;
  } catch (failure) {
    if (failure instanceof BotsApiError && isUnsupported(failure)) return { state: 'unsupported', bots: [] };
    throw failure;
  }
  const chats = await Promise.allSettled(definitions.map((bot) => fetchBotChats(bot.id)));
  return {
    state: 'ready',
    bots: definitions.map((bot, index) => {
      const read = chats[index];
      return { bot: { id: bot.id, name: bot.name, avatar: bot.avatar }, chats: read?.status === 'fulfilled' ? read.value : null };
    }),
  };
}

export function useBotsSidebar(enabled: boolean): BotsSidebarModel {
  const runtime = useBotsRuntime();
  const [read, setRead] = React.useState({ owner: runtime, ...PENDING });
  const issued = React.useRef(0);
  const landed = React.useRef(0);

  const refresh = React.useCallback(() => {
    const request = ++issued.current;
    const lands = () => !runtime.signal.aborted && request > landed.current;
    void (async () => {
      try {
        const next = await readBots();
        if (!lands()) return;
        landed.current = request;
        setRead({ owner: runtime, ...next, failed: false });
      } catch {
        if (!lands()) return;
        landed.current = request;
        setRead((current) => ({ ...(current.owner === runtime ? current : PENDING), owner: runtime, failed: true }));
      }
    })();
  }, [runtime]);

  React.useEffect(() => {
    if (!enabled) return;
    let queued = false;
    let active = true;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (active) refresh(); });
    };
    refresh();
    const release = subscribeOpenchamberEvents((event) => {
      if (event.type === 'event-stream-ready' || event.type === 'bots-changed') schedule();
    });
    return () => { active = false; release(); };
  }, [enabled, refresh]);

  const pageOpen = useUIStore((state) => state.isBotsPageOpen);
  const wasPageOpen = React.useRef(pageOpen);
  React.useEffect(() => {
    if (wasPageOpen.current && !pageOpen && enabled) refresh();
    wasPageOpen.current = pageOpen;
  }, [enabled, pageOpen, refresh]);

  const current = read.owner === runtime ? read : PENDING;
  return React.useMemo(() => ({
    present: current.state === 'pending' ? current.failed : current.state === 'ready',
    bots: current.bots,
    failed: current.failed,
    refresh,
  }), [current, refresh]);
}

const WORKING_STATES: ReadonlySet<BotWorkItem['state']> = new Set(['investigating', 'fixing', 'proving', 'judging', 'merging', 'closing']);
const ENDED_STATES: ReadonlySet<BotWorkItem['state']> = new Set(['done', 'failed', 'stopped']);

export const botItemNeedsYou = (item: BotWorkItem): boolean => item.state === 'needs-you' || item.state === 'waiting-answer';
export const botItemWorking = (item: BotWorkItem): boolean => WORKING_STATES.has(item.state);
const botItemEnded = (item: BotWorkItem): boolean => item.takenOver !== null || ENDED_STATES.has(item.state);

export const botTitleClass = ({ selected = false, needsYou, working }: { readonly selected?: boolean; readonly needsYou: boolean; readonly working: boolean }): string => {
  if (selected) return 'text-interactive-selection-foreground';
  if (needsYou) return 'font-semibold text-foreground';
  return working ? 'text-foreground' : 'oc-title-rest';
};

const botItemChat = (item: BotWorkItem): BotChatTarget | null => {
  if (item.takenOver) return { sessionId: item.takenOver.sessionId, directory: item.worktree };
  return item.conversation ? { sessionId: item.conversation.sessionId, directory: item.conversation.directory } : null;
};

export type BotStatusCounts = { readonly needsYou: number; readonly working: number; readonly queued: number };

export const botStatusCounts = (items: readonly BotWorkItem[]): BotStatusCounts => {
  const live = items.filter((item) => !botItemEnded(item));
  return {
    needsYou: live.filter(botItemNeedsYou).length,
    working: live.filter(botItemWorking).length,
    queued: live.filter((item) => item.state === 'queued').length,
  };
};

const STATUS_KEYS = [
  ['needsYou', 'bots.sidebar.status.needsYouSingle', 'bots.sidebar.status.needsYouPlural'],
  ['working', 'bots.sidebar.status.workingSingle', 'bots.sidebar.status.workingPlural'],
  ['queued', 'bots.sidebar.status.queuedSingle', 'bots.sidebar.status.queuedPlural'],
] as const satisfies readonly (readonly [keyof BotStatusCounts, I18nKey, I18nKey])[];

export function useBotStatusLine(counts: BotStatusCounts): string {
  const { t } = useI18n();
  return STATUS_KEYS.flatMap(([field, single, plural]) => {
    const count = counts[field];
    return count > 0 ? [t(count === 1 ? single : plural, { count })] : [];
  }).join(' · ');
}

const BOT_CHATS_BATCH = 5;

export type BotChatRow = { readonly item: BotWorkItem; readonly target: BotChatTarget };

const chatRows = (items: readonly BotWorkItem[]): BotChatRow[] => items
  .flatMap((item) => {
    const target = botItemChat(item);
    return target ? [{ item, target }] : [];
  })
  .sort((left, right) => right.item.updatedAt - left.item.updatedAt);

export function useBotChatRows(items: readonly BotWorkItem[]) {
  const [showEnded, setShowEnded] = React.useState(false);
  const [limit, setLimit] = React.useState(BOT_CHATS_BATCH);
  const { live, ended } = React.useMemo(() => ({
    live: chatRows(items.filter((item) => !botItemEnded(item))),
    ended: chatRows(items.filter(botItemEnded)),
  }), [items]);
  const listed = showEnded ? [...live, ...ended] : live;
  return {
    rows: listed.slice(0, limit),
    hasEnded: ended.length > 0,
    showEnded,
    toggleEnded: () => setShowEnded((shown) => !shown),
    more: listed.length > limit,
    fewer: limit > BOT_CHATS_BATCH && listed.length > BOT_CHATS_BATCH,
    showMore: () => setLimit((current) => current + BOT_CHATS_BATCH),
    showFewer: () => setLimit(BOT_CHATS_BATCH),
  };
}

export const botExpansionKey = (botId: string): string => `bots:${botId}`;

export function useBotSidebarActions(refresh: () => void, onNavigate?: () => void) {
  const { t } = useI18n();
  const mobile = useMobileAppActions();
  const [openingMainOf, setOpeningMainOf] = React.useState<string | null>(null);

  const openChat = (target: BotChatTarget) => {
    useUIStore.getState().closeMainSurfaces();
    void useSessionUIStore.getState().setCurrentSession(target.sessionId, target.directory);
    onNavigate?.();
  };

  const openMainChat = async (botId: string, known: boolean) => {
    if (openingMainOf !== null) return;
    const runtime = getBotsRuntime();
    setOpeningMainOf(botId);
    try {
      const { session } = await ensureBotMainChat(botId);
      if (runtime.signal.aborted) return;
      openChat({ sessionId: session.sessionId, directory: session.directory });
      if (!known) refresh();
    } catch {
      if (!runtime.signal.aborted) toast.error(t('bots.sidebar.mainChatFailed'));
    } finally {
      setOpeningMainOf(null);
    }
  };

  const newBot = () => {
    const projectId = useProjectsStore.getState().activeProjectId;
    useUIStore.getState().setBotsPageTarget(projectId ? { projectId, newBot: true } : null);
    if (mobile) mobile.openBots(); else useUIStore.getState().setBotsPageOpen(true);
    onNavigate?.();
  };

  return { openChat, openMainChat, openingMainOf, newBot };
}
