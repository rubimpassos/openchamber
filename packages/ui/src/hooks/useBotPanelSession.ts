import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { shallow } from 'zustand/shallow';
import { botAutomation, botMainAutomation } from '@/lib/bots/sessionMetadata';
import type { Session } from '@/lib/opencode/model';
import { isZoneShown, resolveZoneActiveTab, zoneOfMode } from '@/lib/workspace/zones';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionSelector } from '@/sync/sync-context';

export type BotPanelScope = {
  readonly botId: string;
  readonly item: { readonly projectId: string; readonly itemId: string } | null;
};

type SessionOwner =
  | { readonly kind: 'unknown' | 'ordinary' }
  | { readonly kind: 'bot'; readonly botId: string; readonly projectId: string | null; readonly itemId: string | null };
const UNKNOWN: SessionOwner = { kind: 'unknown' };
const ORDINARY: SessionOwner = { kind: 'ordinary' };

const ownerOf = (session: Session | undefined): SessionOwner => {
  if (!session) return UNKNOWN;
  const item = botAutomation(session);
  if (item) return { kind: 'bot', botId: item.botId, projectId: item.projectId, itemId: item.itemId };
  const main = botMainAutomation(session);
  return main ? { kind: 'bot', botId: main.botId, projectId: null, itemId: null } : ORDINARY;
};

export function useBotPanelScope(directory: string | undefined): BotPanelScope | null | undefined {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const live = useSessionSelector(sessionId, directory, ownerOf, shallow);
  const listed = useGlobalSessionsStore(useShallow((state) => ownerOf(sessionId ? state.entityById.get(sessionId) : undefined)));
  const owner = !sessionId ? ORDINARY : live.kind === 'bot' ? live : listed.kind === 'unknown' ? live : listed;
  return React.useMemo(() => {
    if (owner.kind !== 'bot') return owner.kind === 'unknown' ? undefined : null;
    return { botId: owner.botId, item: owner.projectId && owner.itemId ? { projectId: owner.projectId, itemId: owner.itemId } : null };
  }, [owner]);
}

const opensOnEntry = new Map<string, boolean>();
const quietOpens = new Set<string>();

export const takeBotPanelQuietOpen = (directory: string): boolean => quietOpens.delete(directory);

const closeBotTab = (directory: string) => {
  const ui = useUIStore.getState();
  const tab = ui.contextPanelByDirectory[directory]?.tabs.find((entry) => entry.mode === 'bot');
  if (tab) ui.closeContextPanelTab(directory, tab.id);
};

export function useBotPanelTab(directory: string) {
  const scope = useBotPanelScope(directory || undefined);
  const isBotSession = scope === undefined ? undefined : scope !== null;
  const hasTab = useUIStore((state) => Boolean(directory && state.contextPanelByDirectory[directory]?.tabs.some((tab) => tab.mode === 'bot')));
  const shown = useUIStore((state) => {
    const panel = directory ? state.contextPanelByDirectory[directory] : undefined;
    const zone = zoneOfMode(state.contextSurfaceZones, 'bot');
    return Boolean(panel && isZoneShown(panel, state.contextSurfaceZones, zone) && resolveZoneActiveTab(panel, state.contextSurfaceZones, zone)?.mode === 'bot');
  });
  const hidden = useUIStore((state) => state.contextRailHiddenSurfaces.includes('bot'));
  const seen = React.useRef({ directory, shown: false });
  React.useLayoutEffect(() => {
    const previous = seen.current;
    seen.current = { directory, shown };
    if (previous.directory && previous.directory !== directory) closeBotTab(previous.directory);
    if (!directory || isBotSession === undefined) return;
    if (shown) opensOnEntry.set(directory, true);
    else if (previous.directory === directory && previous.shown && isBotSession && hasTab) opensOnEntry.set(directory, false);
    const wanted = isBotSession && !hidden;
    if (wanted === hasTab) return;
    if (!wanted) {
      closeBotTab(directory);
      return;
    }
    const ui = useUIStore.getState();
    const zoneBusy = isZoneShown(ui.contextPanelByDirectory[directory], ui.contextSurfaceZones, zoneOfMode(ui.contextSurfaceZones, 'bot'));
    const reveal = !zoneBusy && (opensOnEntry.get(directory) ?? true);
    if (reveal) quietOpens.add(directory);
    ui.openContextPanelTab(directory, { mode: 'bot' }, { reveal, recordReturn: false });
  }, [directory, hasTab, hidden, isBotSession, shown]);
}
