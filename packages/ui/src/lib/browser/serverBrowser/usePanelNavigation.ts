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
  readonly initial: boolean;
};

/** Delivers panel-open intent only after its Chrome tab is selected. */
export const usePanelNavigation = ({ directory, tabID, scope, chromeTabId, navigate, error, disabled }: {
  readonly directory: string;
  readonly tabID: string;
  readonly scope: ServerBrowserScope | null;
  readonly chromeTabId: string | null;
  readonly navigate: (url: string) => Promise<ServerBrowserState | null>;
  readonly error: string | null;
  readonly disabled: boolean;
}): boolean => {
  const [request, setRequest] = React.useState<NavigationRequest | null>(null);
  const started = React.useRef<NavigationRequest | null>(null);

  React.useEffect(() => {
    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs.find((entry) => entry.id === tabID);
    const initial = wasBrowserTabOpenedWithAddress(directory, tabID);
    setRequest(initial && tab?.targetPath ? { directory, tabID, url: tab.targetPath, initial: true } : null);
    return subscribeBrowserTabLoadRequests(directory, tabID, (url) => {
      setRequest({ directory, tabID, url, initial: wasBrowserTabOpenedWithAddress(directory, tabID) });
    });
  }, [directory, tabID]);

  React.useEffect(() => {
    if (disabled || !scope || !request || request.directory !== directory || request.tabID !== tabID || started.current === request) return;
    const chromeTab = scope.tabs.find((tab) => tab.id === chromeTabId && tab.active);
    if (!chromeTab) return;
    // Reopening a working page only focuses it, preserving the person's work.
    if (!request.initial && chromeTab.url && chromeTab.url !== BLANK_URL && !error && !hasFailedPanelNavigation(scope.id, chromeTab.id)) {
      setRequest(null);
      return;
    }
    started.current = request;
    void navigate(normalizeBrowserUrl(request.url)).finally(() => {
      if (request.initial) forgetBrowserTabOpenedWithAddress(directory, tabID);
      setRequest((current) => current === request ? null : current);
    });
  }, [chromeTabId, directory, disabled, error, navigate, request, scope, tabID]);

  return wasBrowserTabOpenedWithAddress(directory, tabID)
    || Boolean(request && request.directory === directory && request.tabID === tabID);
};
