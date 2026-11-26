import React from 'react';
import { useServerBrowserMonitor } from '@/lib/browser/serverBrowser/useServerBrowserMonitor';
import { BUILTIN_BROWSER_PROVIDER } from '@/lib/guests/browser-providers';
import { useUIStore } from '@/stores/useUIStore';
import { ServerBrowsersList } from './ServerBrowsersList';

export const ServerBrowsersSection: React.FC<{
  sessionId: string | null;
  directory: string | null;
  visible?: boolean;
}> = ({ sessionId, directory, visible = true }) => {
  const browserProvider = useUIStore((state) => state.browserProvider);
  const provider = browserProvider && browserProvider !== BUILTIN_BROWSER_PROVIDER ? browserProvider : null;
  const monitor = useServerBrowserMonitor(provider, directory, visible);
  return <ServerBrowsersList monitor={monitor} sessionId={sessionId} directory={directory} />;
};
