import React from 'react';
import { BrowserPane } from '@/components/browser/BrowserPane';
import type { BrowserToolbarMenuItem } from '@/components/browser/BrowserToolbar';
import { ServerBrowserView } from '@/components/browser/ServerBrowserView';
import { Button } from '@/components/ui/button';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useMobileServerBrowserTabs } from '@/hooks/useMobileServerBrowserTabs';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { SpacePreparing } from '@/components/session/spaces/SpacePreparing';
import { previewFramesIsolated } from '@/lib/browser/mobileDevTunnel';
import { browserUrlLabel } from '@/lib/browser/url';
import { BUILTIN_BROWSER_PROVIDER } from '@/lib/guests/browser-providers';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

const MobileServerBrowser: React.FC<{
  guestId: string;
  directory: string;
  browser: ReturnType<typeof useMobileServerBrowserTabs>;
  visible: boolean;
  registerBackHandler: (handler: (() => boolean) | null) => void;
}> = ({ guestId, directory, browser, visible, registerBackHandler }) => {
  const { t } = useI18n();
  const { tabs, activeId, select, open, close } = browser;
  const several = tabs.length > 1;
  const menuItems: BrowserToolbarMenuItem[] = [
    ...(several ? tabs.map((tab) => ({
      kind: 'item' as const,
      id: `tab-${tab.id}`,
      icon: 'global' as const,
      label: tab.targetPath ? browserUrlLabel(tab.targetPath) : t('contextPanel.mode.browser'),
      onSelect: () => select(tab.id),
      pressed: tab.id === activeId,
    })) : []),
    { kind: 'item', id: 'new-tab', icon: 'add', label: t('contextPanel.browser.newTab'), onSelect: open },
    ...(several && activeId ? [{
      kind: 'item' as const, id: 'close-tab', icon: 'close' as const, label: t('contextPanel.browser.tabs.close'), onSelect: () => close(activeId),
    }] : []),
  ];
  return (
    <>
      <ServerBrowserView guestId={guestId} directory={directory} tabID={visible ? activeId : null} menuItems={menuItems} registerBackHandler={registerBackHandler} />
      {activeId ? null : (
        <div className="flex h-full items-center justify-center p-6">
          <Button variant="outline" onClick={open}>{t('contextPanel.browser.newTab')}</Button>
        </div>
      )}
    </>
  );
};

export const MobileBrowserSurface: React.FC<{
  visible: boolean;
  registerBackHandler: (handler: (() => boolean) | null) => void;
}> = ({ visible, registerBackHandler }) => {
  const { t } = useI18n();
  const ownDirectory = useEffectiveDirectory();
  const draftSpace = useDraftSpaceTarget();
  const siteDirectory = panelContentDirectory(draftSpace, ownDirectory);
  const browserProvider = useUIStore((state) => state.browserProvider);
  const serverGuest = browserProvider && browserProvider !== BUILTIN_BROWSER_PROVIDER ? browserProvider : null;
  const serverBrowser = useMobileServerBrowserTabs(ownDirectory ?? '', serverGuest);
  const [isolated, setIsolated] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (serverGuest) return undefined;
    let cancelled = false;
    void previewFramesIsolated().then((value) => {
      if (!cancelled) setIsolated(value);
    });
    return () => { cancelled = true; };
  }, [serverGuest]);
  if (draftSpace?.kind === 'preparing') return <SpacePreparing />;
  if (serverGuest) {
    return <MobileServerBrowser guestId={serverGuest} directory={ownDirectory ?? ''} browser={serverBrowser} visible={visible} registerBackHandler={registerBackHandler} />;
  }
  if (isolated === null) return null;
  if (!isolated) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center typography-micro text-muted-foreground">
        {t('contextPanel.browser.unsafeWebView')}
      </div>
    );
  }
  return (
    <BrowserPane
      key={siteDirectory ?? ''}
      initialUrl=""
      directory={ownDirectory ?? ''}
      siteDirectory={siteDirectory ?? ''}
      tabID="mobile-preview"
      ownerSessionId={null}
      showHome
      registerBackHandler={registerBackHandler}
      visible={visible}
    />
  );
};
