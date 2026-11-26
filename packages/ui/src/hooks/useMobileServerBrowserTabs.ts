import React from 'react';

import { BUILTIN_BROWSER_PROVIDER } from '@/lib/guests/browser-providers';
import { getZoneView, zoneOfMode } from '@/lib/workspace/zones';
import type { ContextPanelTab } from '@/stores/ui/types';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const NO_TABS: readonly ContextPanelTab[] = [];

type MobileServerBrowserTabs = {
  readonly tabs: readonly ContextPanelTab[];
  readonly activeId: string | null;
  readonly select: (tabId: string) => void;
  readonly open: () => void;
  readonly close: (tabId: string) => void;
};

const browserTabsOfChat = (tabs: readonly ContextPanelTab[] | undefined, sessionId: string | null): readonly ContextPanelTab[] => {
  const owned = (tabs ?? NO_TABS).filter((tab) => tab.mode === 'browser' && tab.ownerSessionId === sessionId);
  return owned.length > 0 ? owned : NO_TABS;
};

export const openBrowserOfChatOnScreen = (directory: string | null | undefined): void => {
  const ui = useUIStore.getState();
  const directoryKey = normalizeContextPanelDirectoryKey(directory ?? '');
  if (!directoryKey || !ui.browserProvider || ui.browserProvider === BUILTIN_BROWSER_PROVIDER) return;
  const sessionId = useSessionUIStore.getState().currentSessionId;
  ui.showBrowserTabsOfSession(directoryKey, sessionId);
  const panelTabs = useUIStore.getState().contextPanelByDirectory[directoryKey]?.tabs;
  if (browserTabsOfChat(panelTabs, sessionId).length > 0) return;
  if (sessionId) ui.revealSessionBrowser(directoryKey, sessionId);
  else ui.openContextBrowser(directoryKey);
};

export const useMobileServerBrowserTabs = (directory: string, serverGuest: string | null): MobileServerBrowserTabs => {
  const directoryKey = normalizeContextPanelDirectoryKey(directory);
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const showBrowserTabsOfSession = useUIStore((state) => state.showBrowserTabsOfSession);

  React.useLayoutEffect(() => {
    if (!serverGuest) showBrowserTabsOfSession(null, null);
    else if (directoryKey) showBrowserTabsOfSession(directoryKey, sessionId);
  }, [directoryKey, serverGuest, sessionId, showBrowserTabsOfSession]);

  const panelTabs = useUIStore((state) => state.contextPanelByDirectory[directoryKey]?.tabs);
  const tabs = React.useMemo(() => browserTabsOfChat(panelTabs, sessionId), [panelTabs, sessionId]);
  const frontId = useUIStore((state) => {
    const panel = state.contextPanelByDirectory[directoryKey];
    return panel ? getZoneView(panel, zoneOfMode(state.contextSurfaceZones, 'browser')).activeTabId : null;
  });
  const newest = tabs.reduce<ContextPanelTab | null>((best, tab) => (!best || tab.touchedAt > best.touchedAt ? tab : best), null);
  const activeId = (tabs.find((tab) => tab.id === frontId) ?? newest)?.id ?? null;

  const stopFollowingAgent = React.useCallback(() => {
    if (sessionId) useUIStore.getState().setBrowserFollowAgent(sessionId, false);
  }, [sessionId]);

  return {
    tabs,
    activeId,
    select: React.useCallback((tabId) => {
      stopFollowingAgent();
      useUIStore.getState().setActiveContextPanelTab(directoryKey, tabId);
    }, [directoryKey, stopFollowingAgent]),
    open: React.useCallback(() => {
      stopFollowingAgent();
      useUIStore.getState().showBrowserTabsOfSession(directoryKey, sessionId);
      useUIStore.getState().openNewContextBrowserTab(directoryKey);
    }, [directoryKey, sessionId, stopFollowingAgent]),
    close: React.useCallback((tabId) => useUIStore.getState().closeContextPanelTab(directoryKey, tabId), [directoryKey]),
  };
};
