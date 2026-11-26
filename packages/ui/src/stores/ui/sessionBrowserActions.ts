import { isVSCodeRuntime } from '@/lib/desktop';
import { splitBrowserTabsForSession } from '@/lib/browser/serverBrowser/sessionTabs';
import {
  CONTEXT_ZONES,
  getZoneView,
  keepZoneViewsOnTabs,
  resolveZoneActiveTabId,
  settleZones,
  withZoneView,
  zoneOfMode,
} from '@/lib/workspace/zones';
import { createBrowserTabDedupeKey } from './browserTabIdentity';
import { withParkedBrowserTabs } from './parkedBrowserTabs';
import { normalizeDirectoryPath } from './contextTabs';
import type { ContextPanelDirectoryState, ContextPanelTab, UIStoreSlice } from './types';

const BROWSER_FOLLOW_OFF_MAX = 200;

export const isFollowingBrowserAgent = (offSessions: readonly string[], sessionId: string | null): boolean => (
  sessionId !== null && !offSessions.includes(sessionId)
);

export const createSessionBrowserActions: UIStoreSlice<
  'showBrowserTabsOfSession' | 'revealSessionBrowser' | 'setBrowserFollowAgent'
> = (set, get) => ({
  showBrowserTabsOfSession: (currentDirectory, sessionId) => {
    const current = currentDirectory ? normalizeDirectoryPath(currentDirectory.trim()) : null;
    set((state) => {
      let byDirectory: Record<string, ContextPanelDirectoryState> | null = null;
      for (const [directory, panel] of Object.entries(state.contextPanelByDirectory)) {
        const parked = panel.parkedBrowserTabs ?? [];
        let next: ContextPanelDirectoryState;
        if (current === null) {
          if (parked.length === 0) continue;
          next = withParkedBrowserTabs({ ...panel, tabs: [...panel.tabs, ...parked] }, []);
        } else {
          const split = splitBrowserTabsForSession(panel.tabs, parked, sessionId, directory === current);
          if (!split) continue;
          const shownIds = new Set(split.tabs.map((tab) => tab.id));
          const parkedIds = new Set(split.parked.map((tab) => tab.id));
          const leavingActive = CONTEXT_ZONES
            .map((zone) => getZoneView(panel, zone))
            .filter((view) => view.isOpen)
            .map((view) => view.activeTabId)
            .filter((id): id is string => id !== null && parkedIds.has(id));
          const parkedActive = [...(panel.parkedActiveTabIds ?? []), ...leavingActive];
          const returning = new Set(parkedActive.filter((id) => shownIds.has(id)));
          const newest = split.tabs
            .filter((tab) => tab.mode === 'browser')
            .reduce<ContextPanelTab | null>((best, tab) => (!best || tab.touchedAt > best.touchedAt ? tab : best), null);
          const returningBrowser = split.tabs.find((tab) => returning.has(tab.id) && tab.mode === 'browser') ?? null;
          let moved = withParkedBrowserTabs({ ...panel, tabs: split.tabs }, split.parked, parkedActive);
          const browserZone = zoneOfMode(state.contextSurfaceZones, 'browser');
          for (const zone of CONTEXT_ZONES) {
            const view = getZoneView(moved, zone);
            const leftChat = Boolean(view.activeTabId && parkedIds.has(view.activeTabId));
            if (zone === browserZone && returningBrowser) {
              moved = withZoneView(moved, zone, { activeTabId: returningBrowser.id, isOpen: true });
              continue;
            }
            if (!leftChat) continue;
            moved = withZoneView(moved, zone, { activeTabId: newest && browserZone === zone ? newest.id : null });
          }
          next = settleZones({ ...moved, zones: keepZoneViewsOnTabs(moved.zones, shownIds) }, state.contextSurfaceZones);
        }
        byDirectory ??= { ...state.contextPanelByDirectory };
        byDirectory[directory] = next;
      }
      const previous = state.browserSessionContext;
      const selection = current === null ? null
        : previous?.directory === current && previous.sessionId === sessionId
          ? previous : { directory: current, sessionId };
      return byDirectory || selection !== previous
        ? { contextPanelByDirectory: byDirectory ?? state.contextPanelByDirectory, browserSessionContext: selection }
        : state;
    });
  },

  revealSessionBrowser: (directory, sessionId) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return;
    const state = get();
    const panel = state.contextPanelByDirectory[normalizedDirectory];
    const zone = zoneOfMode(state.contextSurfaceZones, 'browser');
    const view = panel ? getZoneView(panel, zone) : null;
    const browserTabs = (panel?.tabs ?? []).filter((tab) => tab.mode === 'browser'
      && (tab.ownerSessionId === sessionId || tab.ownerSessionId === null));
    const shownId = panel ? resolveZoneActiveTabId(panel.tabs, state.contextSurfaceZones, zone, view?.activeTabId ?? null) : null;
    if (view?.isOpen && browserTabs.some((tab) => tab.id === shownId)) return;
    const pick = browserTabs.find((tab) => tab.id === view?.activeTabId)
      ?? browserTabs.reduce<ContextPanelTab | null>((best, tab) => (!best || tab.touchedAt > best.touchedAt ? tab : best), null);
    if (pick) {
      state.setActiveContextPanelTab(normalizedDirectory, pick.id);
      return;
    }
    state.openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: '',
      dedupeKey: createBrowserTabDedupeKey('agent'),
      label: null,
      ownerSessionId: sessionId,
    });
  },

  setBrowserFollowAgent: (sessionId, value) => {
    set((state) => {
      const off = state.browserFollowAgentOffSessions.includes(sessionId);
      if (off !== value) return state;
      const rest = state.browserFollowAgentOffSessions.filter((id) => id !== sessionId);
      return { browserFollowAgentOffSessions: value ? rest : [...rest, sessionId].slice(-BROWSER_FOLLOW_OFF_MAX) };
    });
  },
});
