import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import {
  forgetBrowserTabOpenedWithAddress,
  subscribeBrowserTabLoadRequests,
  wasBrowserTabOpenedWithAddress,
} from '../devServerWait';
import { BLANK_URL, normalizeBrowserUrl } from '../url';
import type { ServerBrowserScope, ServerBrowserState } from './types';
import { hasFailedPanelNavigation } from './panelTabs';

type NavigationRequest = {
  readonly directory: string;
  readonly tabID: string;
  readonly url: string;
} & (
  | { readonly intent: 'open' }
  | { readonly intent: 'reveal' }
  | { readonly intent: 'load'; readonly sessionId: string | null }
);

type PanelNavigation = {
  readonly pending: boolean;
  readonly requestedUrl: string | null;
  readonly load: (url: string) => void;
};

/** Delivers an address asked of a panel tab only after its Chrome tab is selected. */
export const usePanelNavigation = ({ directory, tabID, sessionId, scope, chromeTabId, navigate, error, disabled }: {
  readonly directory: string;
  readonly tabID: string;
  readonly sessionId: string | null;
  readonly scope: ServerBrowserScope | null;
  readonly chromeTabId: string | null;
  readonly navigate: (url: string) => Promise<ServerBrowserState | null>;
  readonly error: string | null;
  /** A sign-in browser is shown instead of the chat's. */
  readonly disabled: boolean;
}): PanelNavigation => {
  const [request, setRequest] = React.useState<NavigationRequest | null>(null);
  const started = React.useRef<NavigationRequest | null>(null);

  React.useEffect(() => {
    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs.find((entry) => entry.id === tabID);
    const opened = wasBrowserTabOpenedWithAddress(directory, tabID);
    setRequest(opened && tab?.targetPath ? { directory, tabID, url: tab.targetPath, intent: 'open' } : null);
    return subscribeBrowserTabLoadRequests(directory, tabID, (url) => {
      setRequest({ directory, tabID, url, intent: wasBrowserTabOpenedWithAddress(directory, tabID) ? 'open' : 'reveal' });
    });
  }, [directory, tabID]);

  React.useEffect(() => {
    if (!request || request.directory !== directory || request.tabID !== tabID || started.current === request) return;
    if (request.intent === 'load' && (disabled || request.sessionId !== sessionId)) {
      setRequest(null);
      return;
    }
    if (disabled || !scope) return;
    const chromeTab = scope.tabs.find((tab) => tab.id === chromeTabId && tab.active);
    if (!chromeTab) return;
    // Reopening a working page only focuses it, preserving the person's work.
    if (request.intent === 'reveal' && chromeTab.url && chromeTab.url !== BLANK_URL && !error && !hasFailedPanelNavigation(scope.id, chromeTab.id)) {
      setRequest(null);
      return;
    }
    started.current = request;
    void navigate(normalizeBrowserUrl(request.url)).finally(() => {
      if (request.intent === 'open') forgetBrowserTabOpenedWithAddress(directory, tabID);
      setRequest((current) => current === request ? null : current);
    });
  }, [chromeTabId, directory, disabled, error, navigate, request, scope, sessionId, tabID]);

  const load = React.useCallback((url: string) => {
    forgetBrowserTabOpenedWithAddress(directory, tabID);
    setRequest({ directory, tabID, url, intent: 'load', sessionId });
  }, [directory, sessionId, tabID]);

  const current = request && request.directory === directory && request.tabID === tabID ? request : null;
  return {
    pending: current !== null || wasBrowserTabOpenedWithAddress(directory, tabID),
    requestedUrl: !disabled && current && current.intent !== 'reveal' ? current.url : null,
    load,
  };
};
