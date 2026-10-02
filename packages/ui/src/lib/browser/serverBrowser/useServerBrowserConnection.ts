/**
 * Polls and drives the built-in server browser's dock state for one chat.
 *
 * The service keeps exactly one scope "selected" at a time — whichever chat's
 * tab is being mirrored over the shared surface — and gates every dock
 * command (navigate, back, tabs, viewport…) on a `generation` the caller must
 * have last read from `state`, so a command built from a picture of an
 * earlier view is refused rather than landing somewhere unexpected. This hook
 * keeps that generation current and exposes one `act` wrapper so callers
 * never have to thread it through by hand.
 */
import React from 'react';

import { useSessionUIStore } from '@/sync/session-ui-store';

import {
  captureServerBrowserPage,
  clearServerBrowserData,
  closeServerBrowserScope,
  evaluateServerBrowserPage,
  getServerBrowserState,
  goServerBrowserBack,
  goServerBrowserForward,
  navigateServerBrowser,
  newServerBrowserTab,
  closeServerBrowserTab,
  openServerBrowserScope,
  reloadServerBrowser,
  selectServerBrowserScope,
  selectServerBrowserTab,
  setServerBrowserViewer,
  setServerBrowserViewport,
  setServerBrowserZoom,
  stopServerBrowser,
  type ServerBrowserCapture,
  type ServerBrowserResult,
} from './client';
import { findSelectedScope, type ServerBrowserScope, type ServerBrowserState } from './types';

const POLL_MS = 2_000;
const POLL_MS_HIDDEN = 10_000;

export type ServerBrowserConnection = {
  readonly state: ServerBrowserState | null;
  readonly scope: ServerBrowserScope | null;
  readonly sessionId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly navigate: (url: string) => Promise<void>;
  readonly back: () => Promise<void>;
  readonly forward: () => Promise<void>;
  readonly reload: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly newTab: () => Promise<void>;
  readonly selectTab: (tabId: string) => Promise<void>;
  readonly closeTab: (tabId: string) => Promise<void>;
  readonly setViewport: (viewport: { mode: 'auto' | 'fixed'; mobile: boolean; width?: number; height?: number }) => Promise<void>;
  readonly setZoom: (level: number) => Promise<void>;
  readonly clearData: (what: 'cookies' | 'cache') => Promise<void>;
  readonly selectScope: (scopeId: string) => Promise<void>;
  readonly closeScope: (scopeId: string) => Promise<void>;
  readonly evaluate: (expression: string, userGesture?: boolean) => Promise<unknown>;
  readonly capture: () => Promise<ServerBrowserCapture | null>;
};

export const useServerBrowserConnection = (
  guestId: string,
  directory: string,
  viewerId: string | undefined,
): ServerBrowserConnection => {
  const sessionId = useSessionUIStore((storeState) => storeState.currentSessionId);
  const [state, setState] = React.useState<ServerBrowserState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);
  const stateRef = React.useRef<ServerBrowserState | null>(null);

  const applyState = React.useCallback((next: ServerBrowserState) => {
    stateRef.current = next;
    generationRef.current = next.generation;
    setState(next);
    setError(null);
  }, []);

  const act = React.useCallback(async (
    fn: (generation: number) => Promise<ServerBrowserResult<ServerBrowserState>>,
  ): Promise<void> => {
    const result = await fn(generationRef.current);
    if (result.ok) {
      applyState(result.data);
      return;
    }
    setError(result.error);
  }, [applyState]);

  const refresh = React.useCallback(async (): Promise<void> => {
    const result = await getServerBrowserState(guestId, viewerId);
    if (result.ok) {
      applyState(result.data);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [applyState, guestId, viewerId]);

  // Attaches this chat's scope (creating it if needed) and brings it to the
  // front of the shared surface. Re-runs when the current chat changes, so
  // switching chats while the panel is open follows the switch.
  React.useEffect(() => {
    if (!sessionId || viewerId === undefined) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const result = await openServerBrowserScope(guestId, viewerId, {
        directory,
        sessionId,
        generation: generationRef.current,
      });
      if (cancelled) return;
      if (result.ok) applyState(result.data);
      else setError(result.error);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [applyState, directory, guestId, sessionId, viewerId]);

  // Tells the service our pixel ratio once a viewer is attached, so a
  // high-DPI client gets crisp frames from the start.
  React.useEffect(() => {
    if (viewerId === undefined) return;
    void setServerBrowserViewer(guestId, viewerId, { devicePixelRatio: window.devicePixelRatio || 1 })
      .then((result) => { if (result.ok) applyState(result.data); });
  }, [applyState, guestId, viewerId]);

  React.useEffect(() => {
    if (viewerId === undefined) return;
    let disposed = false;
    const tick = async () => {
      if (disposed) return;
      const result = await getServerBrowserState(guestId, viewerId);
      if (!disposed && result.ok) applyState(result.data);
      if (disposed) return;
      const delay = document.visibilityState === 'hidden' ? POLL_MS_HIDDEN : POLL_MS;
      timer = setTimeout(tick, delay);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => { disposed = true; clearTimeout(timer); };
  }, [applyState, guestId, viewerId]);

  const scope = React.useMemo(() => findSelectedScope(state), [state]);

  return {
    state,
    scope,
    sessionId,
    loading,
    error,
    refresh,
    navigate: (url) => act((generation) => navigateServerBrowser(guestId, viewerId, { url, generation })),
    back: () => act((generation) => goServerBrowserBack(guestId, viewerId, generation)),
    forward: () => act((generation) => goServerBrowserForward(guestId, viewerId, generation)),
    reload: () => act((generation) => reloadServerBrowser(guestId, viewerId, generation)),
    stop: () => act((generation) => stopServerBrowser(guestId, viewerId, generation)),
    newTab: () => act((generation) => newServerBrowserTab(guestId, viewerId, { generation })),
    selectTab: (tabId) => act((generation) => selectServerBrowserTab(guestId, viewerId, { generation, tabId })),
    closeTab: (tabId) => act((generation) => closeServerBrowserTab(guestId, viewerId, { generation, tabId })),
    setViewport: (viewport) => act((generation) => setServerBrowserViewport(guestId, viewerId, { generation, ...viewport })),
    setZoom: (level) => act((generation) => setServerBrowserZoom(guestId, viewerId, { generation, level })),
    clearData: (what) => act((generation) => clearServerBrowserData(guestId, viewerId, { generation, what })),
    selectScope: (scopeId) => act((generation) => selectServerBrowserScope(guestId, viewerId, { scopeId, generation })),
    closeScope: (scopeId) => act((generation) => closeServerBrowserScope(guestId, viewerId, { scopeId, generation })),
    evaluate: async (expression, userGesture) => {
      const result = await evaluateServerBrowserPage(guestId, viewerId, {
        generation: generationRef.current,
        expression,
        userGesture,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data.value;
    },
    capture: async () => {
      const result = await captureServerBrowserPage(guestId, viewerId, { generation: generationRef.current });
      return result.ok ? result.data : null;
    },
  };
};
