import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import { pushRouteEntry } from '@/lib/router/backGuard';
import { isSessionOpenRedirect, openSession } from '@/lib/router/openSessionFromRoute';
import { openGuestPanelFromRoute } from '@/lib/router/openGuestPanelFromRoute';
import { listenForNotificationNavigation } from '@/lib/router/notificationNavigation';
import { openBotsFromRoute } from '@/lib/router/openBotsFromRoute';
import { getBotsRuntime } from '@/lib/botsRuntime';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { RouteState, AppRouteState } from '@/lib/router';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}

export function useRouter(openMobileBots?: () => void): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);

  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);
  const pendingRouteRef = React.useRef<{ route: RouteState; initial: boolean; normalize: boolean } | null>(null);
  const routeGenerationRef = React.useRef(0);
  const routeAbortRef = React.useRef<AbortController | null>(null);
  const routeLoopRef = React.useRef(0);

  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  React.useEffect(() => subscribeRuntimeEndpointWillChange(({ runtimeKey, previousRuntimeKey }) => {
    if (runtimeKey === previousRuntimeKey) return;
    routeGenerationRef.current += 1;
    routeAbortRef.current?.abort();
    routeLoopRef.current += 1;
    isApplyingRouteRef.current = false;
    pendingRouteRef.current = null;
    useUIStore.getState().setBotsPageOpen(false);
  }), []);

  const applyRouteState = React.useCallback(
    async (route: RouteState) => {
      const generation = routeGenerationRef.current;
      const runtime = getBotsRuntime();
      const controller = new AbortController();
      routeAbortRef.current = controller;
      if (!route.settingsPath && useUIStore.getState().isSettingsDialogOpen) {
        setSettingsDialogOpen(false);
      }

      if (route.sessionId) {
        await openSession(route.sessionId, { messageId: route.messageId, signal: controller.signal });
        if (runtime.signal.aborted || generation !== routeGenerationRef.current) return false;
      }

      if (route.settingsPath) {
        setSettingsPage(resolveSettingsSlug(route.settingsPath));
        setSettingsDialogOpen(true);
        return true;
      }

      if (route.tab && route.tab !== 'chat') {
        const directory = useDirectoryStore.getState().currentDirectory;
        if (directory) {
          const mode: ContextPanelMode = route.tab === 'files' ? 'file' : route.tab;
          useUIStore.getState().openContextSurface(directory, mode);
        }
      }

      if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
        navigateToDiff(route.diffFile);
      }
      if (route.guestPanelId) {
        const directory = useDirectoryStore.getState().currentDirectory;
        if (directory) await openGuestPanelFromRoute(directory, route.guestPanelId);
      }
      return !runtime.signal.aborted && generation === routeGenerationRef.current;
    },
    [setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  const getCurrentAppState = React.useCallback((): AppRouteState => {
    const sessionState = useSessionUIStore.getState();
    const uiState = useUIStore.getState();

    return {
      sessionId: sessionState.currentSessionId,
      isSettingsOpen: uiState.isSettingsDialogOpen,
      settingsPath: uiState.settingsPage,
    };
  }, []);

  const applyRoute = React.useCallback(async (route: RouteState, initial = false) => {
    routeGenerationRef.current += 1;
    routeAbortRef.current?.abort();
    // Item navigation has no session dependency and supersedes a session load.
    if (route.botsTarget) {
      routeLoopRef.current += 1;
      isApplyingRouteRef.current = false;
      pendingRouteRef.current = null;
      if (!isVSCode) {
        openBotsFromRoute(route.botsTarget, openMobileBots);
        if (hasRouteParams()) updateBrowserURL(getCurrentAppState(), { replace: true, force: initial });
      }
      return;
    }
    pendingRouteRef.current = { route, initial, normalize: hasRouteParams() };
    if (isApplyingRouteRef.current) return;
    const loop = ++routeLoopRef.current;
    isApplyingRouteRef.current = true;
    try {
      while (pendingRouteRef.current) {
        const request = pendingRouteRef.current;
        pendingRouteRef.current = null;
        const applied = await applyRouteState(request.route);
        if (loop !== routeLoopRef.current) return;
        if (!applied) continue;
        if (!isVSCode && request.normalize && !request.route.messageId && !pendingRouteRef.current) {
          const state = getCurrentAppState();
          updateBrowserURL(request.initial ? {
            ...state,
            sessionId: state.sessionId ?? request.route.sessionId,
            settingsPath: request.route.settingsPath ?? state.settingsPath,
          } : state, { replace: true, force: request.initial });
        }
      }
    } finally {
      if (loop === routeLoopRef.current) isApplyingRouteRef.current = false;
    }
  }, [applyRouteState, getCurrentAppState, isVSCode, openMobileBots]);

  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (isVSCode || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppState();
      updateBrowserURL(state, options);
    },
    [isVSCode, getCurrentAppState]
  );

  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    if (!hasRouteParams()) {
      syncURLFromState({ replace: true });
      return;
    }

    const route = parseRoute();

    void applyRoute(route, true);
  }, [applyRoute, syncURLFromState]);

  React.useEffect(() => {
    if (isVSCode) return;

    return listenForNotificationNavigation((target) => {
      if (isApplyingRouteRef.current) return false;
      const route = parseRoute(target.searchParams);
      pushRouteEntry({}, target.href);
      void applyRoute(route).catch((error) => {
        console.error('[PWA] notification navigation failed:', error);
      });
      return true;
    });
  }, [applyRoute, isVSCode]);

  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSessionId: string | null = useSessionUIStore.getState().currentSessionId;

    const unsubscribe = useSessionUIStore.subscribe((state) => {
      const sessionId = state.currentSessionId;

      if (sessionId === prevSessionId) {
        return;
      }

      prevSessionId = sessionId;
      syncURLFromState({ replace: isSessionOpenRedirect() });
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;

    const unsubscribe = useUIStore.subscribe((state) => {
      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;

      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;

      if (isApplyingRouteRef.current) {
        return;
      }

      if (settingsOpenChanged || settingsPathChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    const handlePopState = () => {
      const route = parseRoute();

      void applyRoute(route);
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode]);
}
