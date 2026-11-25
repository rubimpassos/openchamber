import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { BUILTIN_BROWSER_PROVIDER } from '@/lib/guests/browser-providers';
import { openMobileWorkspace } from '@/lib/mobileWorkspaceTabs';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const browserPanelAvailable = (): boolean => {
  const provider = useUIStore.getState().browserProvider;
  return !isVSCodeRuntime() && (isDesktopShell() || Boolean(provider && provider !== BUILTIN_BROWSER_PROVIDER));
};

export const openBrowserPanel = (directory: string, url: string): boolean => {
  if (!directory || !browserPanelAvailable()) return false;
  if (isMobileSurfaceRuntime() && !openMobileWorkspace({ tab: 'preview' })) return false;
  const ui = useUIStore.getState();
  if (ui.browserProvider !== BUILTIN_BROWSER_PROVIDER) {
    ui.showBrowserTabsOfSession(directory, useSessionUIStore.getState().currentSessionId);
  }
  ui.openContextPreview(directory, url);
  return true;
};
