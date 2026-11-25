import React from 'react';
import { getServerBrowserState } from '@/lib/browser/serverBrowser/client';
import { followsBrowserSession } from '@/lib/browser/serverBrowser/followSession';
import { BUILTIN_BROWSER_PROVIDER } from '@/lib/guests/browser-providers';
import { loadGuestServiceStatus } from '@/lib/guests/service';
import { openMobileWorkspace } from '@/lib/mobileWorkspaceTabs';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { isFollowingBrowserAgent, normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useBrowserProviderSync } from './useBrowserProviderSync';
import { useEffectiveDirectory } from './useEffectiveDirectory';

export const useMobileBrowserNavigation = (view: { readonly showing: boolean; readonly close: () => void }): void => {
  useBrowserProviderSync();
  const directory = useEffectiveDirectory();
  const directoryKey = normalizeContextPanelDirectoryKey(directory ?? '');
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const provider = useUIStore((state) => state.browserProvider);
  const guestId = provider && provider !== BUILTIN_BROWSER_PROVIDER ? provider : null;
  const previous = React.useRef({ directoryKey, sessionId });
  const viewRef = React.useRef(view);
  viewRef.current = view;

  React.useLayoutEffect(() => {
    const changed = previous.current.directoryKey !== directoryKey || previous.current.sessionId !== sessionId;
    previous.current = { directoryKey, sessionId };
    const ui = useUIStore.getState();
    if (!guestId) {
      ui.showBrowserTabsOfSession(null, null);
      return;
    }
    if (!directoryKey) return;
    ui.showBrowserTabsOfSession(directoryKey, sessionId);
    const tabs = useUIStore.getState().contextPanelByDirectory[directoryKey]?.tabs ?? [];
    if (changed && viewRef.current.showing && !tabs.some((tab) => tab.mode === 'browser' && tab.ownerSessionId === sessionId)) {
      viewRef.current.close();
    }
  }, [directoryKey, guestId, sessionId]);

  React.useEffect(() => {
    if (!guestId || !directoryKey) return undefined;
    const reveal = (targetSessionId: string, targetDirectory: string, targetGuestId: string): void => {
      const ui = useUIStore.getState();
      if (!followsBrowserSession(
        { guestId: targetGuestId, directory: targetDirectory, sessionId: targetSessionId },
        { guestId: ui.browserProvider, directory: directoryKey, sessionId: useSessionUIStore.getState().currentSessionId },
        isFollowingBrowserAgent(ui.browserFollowAgentOffSessions, targetSessionId),
      )) return;
      ui.revealSessionBrowser(directoryKey, targetSessionId);
      openMobileWorkspace({ tab: 'preview' });
    };
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'browser-agent-activity' || !event.sessionId || !event.directory) return;
      reveal(event.sessionId, normalizeContextPanelDirectoryKey(event.directory), event.guestId);
    });
    let cancelled = false;
    if (sessionId && isFollowingBrowserAgent(useUIStore.getState().browserFollowAgentOffSessions, sessionId)) {
      void (async () => {
        const status = await loadGuestServiceStatus(guestId);
        if (cancelled || !status.ok || status.result.status !== 'ready') return;
        const state = await getServerBrowserState(guestId, undefined);
        if (cancelled || !state.ok) return;
        if (state.data.scopes.some((scope) => !scope.signIn && scope.sessionId === sessionId
          && scope.tabs.length > 0 && normalizeContextPanelDirectoryKey(scope.directory) === directoryKey)) {
          reveal(sessionId, directoryKey, guestId);
        }
      })();
    }
    return () => { cancelled = true; unsubscribe(); };
  }, [directoryKey, guestId, sessionId]);
};
