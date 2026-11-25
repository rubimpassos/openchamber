import { isVSCodeRuntime } from '@/lib/desktop';
import { noteBrowserTabOpenedWithAddress, requestBrowserTabLoad } from '@/lib/browser/devServerWait';
import { createBrowserTabDedupeKey } from './browserTabIdentity';
import { buildContextPanelTabID, normalizeDirectoryPath } from './contextTabs';
import type { ContextPanelDirectoryState, UIStoreSlice } from './types';

const noteAddressRequested = (
  panels: Record<string, ContextPanelDirectoryState>,
  request: { readonly directory: string; readonly dedupeKey: string; readonly url: string },
): void => {
  const tabID = buildContextPanelTabID('browser', request.dedupeKey);
  if (panels[request.directory]?.tabs.some((tab) => tab.id === tabID)) {
    requestBrowserTabLoad(request.directory, tabID, request.url);
  } else {
    noteBrowserTabOpenedWithAddress(request.directory, tabID);
  }
};

export const createBrowserTabActions: UIStoreSlice<
  'openContextPreview' | 'openAgentBrowserTab' | 'openNewContextBrowserTab' | 'openContextBrowser'
> = (_set, get) => ({
  openContextPreview: (directory, url) => {
    if (!url.trim()) return;
    get().openContextBrowser(directory, url);
  },
  openAgentBrowserTab: (directory, url, ownerSessionId) => {
    const normalized = normalizeDirectoryPath((directory || '').trim());
    if (!normalized || isVSCodeRuntime()) return null;
    const dedupeKey = createBrowserTabDedupeKey('agent');
    if (url.trim()) noteAddressRequested(get().contextPanelByDirectory, { directory: normalized, dedupeKey, url: url.trim() });
    get().openContextPanelTab(normalized, {
      mode: 'browser', targetPath: url.trim(), dedupeKey, label: null, ownerSessionId,
    }, { reveal: false });
    return buildContextPanelTabID('browser', dedupeKey);
  },
  openNewContextBrowserTab: (directory) => {
    const normalized = normalizeDirectoryPath((directory || '').trim());
    if (!normalized || isVSCodeRuntime()) return;
    get().openContextPanelTab(normalized, {
      mode: 'browser', targetPath: '', dedupeKey: createBrowserTabDedupeKey('new'), label: null,
    });
  },
  openContextBrowser: (directory, url = '', options) => {
    const normalized = normalizeDirectoryPath((directory || '').trim());
    if (!normalized || isVSCodeRuntime()) return;
    const targetUrl = url.trim();
    const state = get();
    const owner = state.browserProvider !== 'builtin' && state.browserSessionContext?.directory === normalized
      ? state.browserSessionContext.sessionId : null;
    const dedupeKey = owner ? `browser:session:${owner}:${targetUrl || 'browser'}` : targetUrl || 'browser';
    if (targetUrl) noteAddressRequested(state.contextPanelByDirectory, { directory: normalized, dedupeKey, url: targetUrl });
    state.openContextPanelTab(normalized, { mode: 'browser', targetPath: targetUrl, dedupeKey, label: null }, options);
  },
});
