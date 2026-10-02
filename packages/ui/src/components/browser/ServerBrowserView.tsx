import React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { BLANK_URL, normalizeBrowserUrl } from '@/lib/browser/url';
import {
  cancelAnnotationSession,
  runAnnotationSession,
  type AnnotationHost,
  type PageCapture,
} from '@/lib/browser/annotationSession';
import { resolveAnnotationOverlayTheme } from '@/lib/browser/overlayTheme';
import { suggestFromHistory } from '@/lib/browser/history';
import { selectBrowserHistory, useBrowserHistoryStore } from '@/stores/useBrowserHistoryStore';
import { toDisplayUrl } from '@/lib/browser/devTunnel';
import { FILL_VIEWPORT, type BrowserViewport } from '@/lib/browser/viewport';
import {
  closeServerBrowserProfile,
  closeServerBrowserTab,
  getServerBrowserState,
} from '@/lib/browser/serverBrowser/client';
import {
  claimedChromeTab,
  panelTabsByChromeTab,
  unclaimedChromeTabs,
  useServerBrowserPanelTabs,
  useServerBrowserSignIn,
} from '@/lib/browser/serverBrowser/panelTabs';
import { findSelectedScope, type ServerBrowserState } from '@/lib/browser/serverBrowser/types';
import { useUIStore } from '@/stores/useUIStore';
import { useServerBrowserConnection } from '@/lib/browser/serverBrowser/useServerBrowserConnection';
import type { SurfaceConnectionState, SurfaceControlState } from '@/lib/guests/surface-client';

import { BrowserToolbar } from './BrowserToolbar';
import { BrowserDeviceBar } from './BrowserDeviceBar';
import { BrowserEmptyState } from './BrowserEmptyState';
import { useAnnotationAttach, useAnnotationOverlayLabels } from './useAnnotationAttach';
import { ServerBrowserCanvas, type ServerBrowserCanvasHandle } from './ServerBrowserCanvas';
import { ServerBrowserBanners } from './ServerBrowserBanners';
import { ServerBrowserInspector } from './ServerBrowserInspector';

export type ServerBrowserViewProps = {
  guestId: string;
  directory: string;
  /** The Browser panel tab this view draws; it shows one Chrome tab of the chat. */
  tabID: string;
  /** Only the panel tab in front talks to the server and draws the page. */
  active: boolean;
};

const ZOOM_MIN = -5;
const ZOOM_MAX = 5;

/** Mobile-sized presets get `mobile: true` so the service's layout matches what the picker promises. */
const MOBILE_PRESET_IDS = new Set(['iphone-se', 'iphone-14', 'iphone-14-pro-max', 'pixel-7', 'ipad-mini', 'ipad-pro']);

const toServiceViewport = (viewport: BrowserViewport): { mode: 'auto' | 'fixed'; mobile: boolean; width?: number; height?: number } => {
  if (viewport.kind === 'fill') return { mode: 'auto', mobile: false };
  const mobile = viewport.kind === 'preset' && MOBILE_PRESET_IDS.has(viewport.id);
  return { mode: 'fixed', mobile, width: viewport.width, height: viewport.height };
};

/**
 * Server-engine counterpart to `WebviewBrowser`/`IframeBrowser` in
 * `BrowserPane.tsx`: same toolbar, tabs, annotation, and control UI, driven
 * by the built-in server browser's dock HTTP API instead of a local
 * `<webview>`. The page picture itself comes from the shared-surface
 * protocol (`ServerBrowserCanvas` / `SurfaceClient`), which is also what
 * extension rail panels use — this view never talks to Chrome directly.
 */
const panelTabExists = (directory: string, tabID: string): boolean => Object.values(useUIStore.getState().contextPanelByDirectory)
  .some((panel) => panel?.tabs.some((tab) => tab.id === tabID));

/**
 * Closing a Browser panel tab closes the Chrome tab it showed. Run from the
 * view's unmount, which is also what a chat or directory switch causes, so it
 * only acts once the panel tab is really gone from the store.
 */
const closeChromeTabsOfPanelTab = async (guestId: string, directory: string, tabID: string): Promise<void> => {
  if (panelTabExists(directory, tabID)) return;
  const { claims, release } = useServerBrowserPanelTabs.getState();
  const owned = Object.entries(claims)
    .map(([key, chromeTabId]) => {
      const [scopeId, panelTabId] = key.split('\u0000');
      return { scopeId, panelTabId, chromeTabId };
    })
    .filter((entry) => entry.panelTabId === tabID);
  if (owned.length === 0) return;
  for (const entry of owned) release(entry.scopeId, entry.panelTabId);
  const current = await getServerBrowserState(guestId, undefined);
  if (!current.ok) return;
  const scope = findSelectedScope(current.data);
  for (const entry of owned) {
    if (!scope || scope.id !== entry.scopeId || !scope.tabs.some((tab) => tab.id === entry.chromeTabId)) continue;
    await closeServerBrowserTab(guestId, undefined, { generation: current.data.generation, tabId: entry.chromeTabId });
  }
};

export const ServerBrowserView: React.FC<ServerBrowserViewProps> = (props) => {
  const { guestId, directory, tabID, active } = props;
  React.useEffect(() => () => {
    // After the store update that removed the tab has been rendered.
    queueMicrotask(() => { void closeChromeTabsOfPanelTab(guestId, directory, tabID); });
  }, [directory, guestId, tabID]);
  if (!active) return null;
  return <ServerBrowserLiveView {...props} />;
};

const activeChromeTabOf = (state: ServerBrowserState | null): string | null => (
  findSelectedScope(state)?.tabs.find((tab) => tab.active)?.id ?? null
);

const ServerBrowserLiveView: React.FC<ServerBrowserViewProps> = ({ guestId, directory, tabID }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const canvasHandleRef = React.useRef<ServerBrowserCanvasHandle | null>(null);

  const [viewerId, setViewerId] = React.useState<string | undefined>(undefined);
  const [control, setControl] = React.useState<SurfaceControlState>({ controller: 'none', mine: false });
  const [connection, setConnection] = React.useState<SurfaceConnectionState>({ status: 'connecting' });
  const [canvasFocused, setCanvasFocused] = React.useState(false);

  const signIn = useServerBrowserSignIn((store) => store.signIn);
  const setSignIn = useServerBrowserSignIn((store) => store.setSignIn);
  const serverBrowser = useServerBrowserConnection(guestId, directory, viewerId, true, signIn?.profileId ?? null);
  const { scope, state } = serverBrowser;

  // ---- this panel tab <-> one Chrome tab of the chat ----------------------
  const claims = useServerBrowserPanelTabs((store) => store.claims);
  const claim = useServerBrowserPanelTabs((store) => store.claim);
  const release = useServerBrowserPanelTabs((store) => store.release);
  const openAgentBrowserTab = useUIStore((store) => store.openAgentBrowserTab);
  const closeContextPanelTabs = useUIStore((store) => store.closeContextPanelTabs);
  const setContextPanelTabTargetPath = useUIStore((store) => store.setContextPanelTabTargetPath);
  const panelTabs = useUIStore((store) => store.contextPanelByDirectory[directory]?.tabs);
  const myChromeTab = scope ? claimedChromeTab(claims, scope.id, tabID) : null;
  const pairingRef = React.useRef(false);
  const tabsSignature = scope ? scope.tabs.map((tab) => `${tab.id}:${tab.active ? 1 : 0}`).join(',') : '';

  React.useEffect(() => {
    if (signIn || !scope || pairingRef.current) return;
    const mine = myChromeTab ? scope.tabs.find((tab) => tab.id === myChromeTab) : undefined;
    if (mine) {
      if (!mine.active) {
        pairingRef.current = true;
        void serverBrowser.selectTab(mine.id).finally(() => { pairingRef.current = false; });
      }
      return;
    }
    if (myChromeTab) release(scope.id, tabID);
    const free = unclaimedChromeTabs(claims, scope);
    const activeFree = scope.tabs.find((tab) => tab.active && free.includes(tab.id))?.id;
    const pick = activeFree ?? free[0];
    if (pick) {
      claim(scope.id, tabID, pick);
      return;
    }
    // Every Chrome tab already has a panel tab: this one is new, so it gets
    // a new Chrome tab, which opens blank on the dev-server list.
    pairingRef.current = true;
    void serverBrowser.newTab().then((next) => {
      const opened = activeChromeTabOf(next);
      const nextScope = findSelectedScope(next);
      if (opened && nextScope) claim(nextScope.id, tabID, opened);
    }).finally(() => { pairingRef.current = false; });
    // `scope` changes identity on every poll; the signature is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.id, tabsSignature, myChromeTab, claims, tabID, signIn]);

  // Chrome tabs the page or the agent opened get panel tabs of their own,
  // first reusing panel tabs that show nothing yet (after a reload), and a
  // claimed Chrome tab that closed (a popup that finished) takes its panel
  // tab with it.
  React.useEffect(() => {
    if (signIn || !scope || !myChromeTab || pairingRef.current) return;
    const browserPanelTabs = (panelTabs ?? []).filter((tab) => tab.mode === 'browser');
    const byChromeTab = panelTabsByChromeTab(claims, scope.id);
    const liveIds = new Set(scope.tabs.map((tab) => tab.id));
    const stale = [...byChromeTab.entries()].filter(([chromeTabId, panelTabId]) => !liveIds.has(chromeTabId) && panelTabId !== tabID);
    const anyLive = [...byChromeTab.keys()].some((chromeTabId) => liveIds.has(chromeTabId));
    if (stale.length > 0 && anyLive) {
      for (const [, panelTabId] of stale) release(scope.id, panelTabId);
      closeContextPanelTabs(directory, stale.map(([, panelTabId]) => panelTabId));
    }
    const claimedPanels = new Set(byChromeTab.values());
    const idlePanels = browserPanelTabs.filter((tab) => tab.id !== tabID && !claimedPanels.has(tab.id));
    for (const chromeTabId of unclaimedChromeTabs(claims, scope)) {
      const reuse = idlePanels.shift();
      if (reuse) {
        claim(scope.id, reuse.id, chromeTabId);
        continue;
      }
      const url = scope.tabs.find((tab) => tab.id === chromeTabId)?.url ?? '';
      const panelTabId = openAgentBrowserTab(directory, url === BLANK_URL ? '' : url);
      if (panelTabId) claim(scope.id, panelTabId, chromeTabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.id, tabsSignature, myChromeTab, claims, panelTabs, signIn]);

  // Panel tab names follow the page each one shows.
  React.useEffect(() => {
    if (!scope) return;
    for (const [chromeTabId, panelTabId] of panelTabsByChromeTab(claims, scope.id)) {
      const chromeTab = scope.tabs.find((tab) => tab.id === chromeTabId);
      if (!chromeTab) continue;
      const url = chromeTab.url === BLANK_URL ? '' : toDisplayUrl(chromeTab.url);
      const panelTab = panelTabs?.find((tab) => tab.id === panelTabId);
      if (panelTab && (panelTab.targetPath ?? '') !== url) setContextPanelTabTargetPath(directory, panelTabId, url);
    }
  }, [claims, directory, panelTabs, scope, setContextPanelTabTargetPath]);

  const isSignInScope = Boolean(scope?.directory.startsWith('profile:'));
  // A sign-in browser is not one of this panel's tabs: it is shown as is.
  const showingMine = isSignInScope || Boolean(scope && myChromeTab && scope.tabs.some((tab) => tab.id === myChromeTab && tab.active));

  const closeChatBrowser = React.useCallback(() => {
    if (!scope) return;
    const owned = [...panelTabsByChromeTab(claims, scope.id).values()];
    for (const panelTabId of owned) release(scope.id, panelTabId);
    void serverBrowser.closeScope(scope.id).then(() => {
      const browserPanelIds = (useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [])
        .filter((tab) => tab.mode === 'browser')
        .map((tab) => tab.id);
      closeContextPanelTabs(directory, browserPanelIds);
    });
  }, [claims, closeContextPanelTabs, directory, release, scope, serverBrowser]);

  const [address, setAddress] = React.useState('');
  React.useEffect(() => {
    setAddress(scope ? toDisplayUrl(scope.url) : '');
    // Only the url, not the whole (identity-changing-every-poll) scope object:
    // resyncing on every poll tick would fight whatever the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.url]);

  const [showDeviceBar, setShowDeviceBar] = React.useState(false);
  const [viewport, setViewport] = React.useState<BrowserViewport>(FILL_VIEWPORT);
  const [isAnnotating, setIsAnnotating] = React.useState(false);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [clearConfirm, setClearConfirm] = React.useState<'cookies' | 'cache' | null>(null);
  const [savingSignIn, setSavingSignIn] = React.useState(false);

  const history = useBrowserHistoryStore(selectBrowserHistory(directory));
  const recordHistoryVisit = useBrowserHistoryStore((storeState) => storeState.recordVisit);
  const forgetHistoryVisit = useBrowserHistoryStore((storeState) => storeState.forget);
  const suggestions = React.useMemo(() => suggestFromHistory(history, address), [history, address]);

  const servedUrlRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!scope || scope.isLoading || !scope.url || scope.url === BLANK_URL) return;
    if (servedUrlRef.current === scope.url) return;
    servedUrlRef.current = scope.url;
    recordHistoryVisit(directory, { url: toDisplayUrl(scope.url), title: scope.title });
  }, [directory, recordHistoryVisit, scope]);

  const annotationHost = React.useMemo<AnnotationHost>(() => ({
    executeJavaScript: (code, userGesture) => serverBrowser.evaluate(code, userGesture),
    capturePage: async (): Promise<PageCapture | null> => {
      const capture = await serverBrowser.capture();
      return capture ? { mime: capture.mime, base64: capture.base64, width: capture.width, height: capture.height } : null;
    },
  }), [serverBrowser]);

  const attachAnnotation = useAnnotationAttach(directory);
  const overlayLabels = useAnnotationOverlayLabels();

  const handleAnnotate = React.useCallback(() => {
    if (isAnnotating) {
      setIsAnnotating(false);
      void cancelAnnotationSession(annotationHost);
      return;
    }
    if (!scope?.url || scope.url === BLANK_URL) {
      toast.error(t('contextPanel.browser.annotate.noPage'));
      return;
    }
    const theme = resolveAnnotationOverlayTheme(currentTheme.metadata.variant === 'light' ? 'light' : 'dark');
    setIsAnnotating(true);
    void runAnnotationSession({ host: annotationHost, theme, labels: overlayLabels })
      .then(async (result) => {
        setIsAnnotating(false);
        if (!result) return;
        await attachAnnotation(result);
      })
      .catch(() => {
        setIsAnnotating(false);
        toast.error(t('contextPanel.browser.annotate.failed'));
      });
  }, [annotationHost, attachAnnotation, currentTheme, isAnnotating, overlayLabels, scope?.url, t]);

  const handleSaveSignIn = React.useCallback(() => {
    const profileId = scope?.profile?.id;
    if (!profileId) return;
    setSavingSignIn(true);
    void closeServerBrowserProfile(guestId, viewerId, { id: profileId })
      .then((result) => {
        if (result.ok) {
          toast.success(t('contextPanel.browser.server.help.saveSignInSuccess'));
          // Back to this chat's own browser.
          if (signIn?.profileId === profileId) setSignIn(null);
          void serverBrowser.refresh();
        } else {
          toast.error(t('contextPanel.browser.server.help.saveSignInFailed'));
        }
      })
      .finally(() => setSavingSignIn(false));
  }, [guestId, scope?.profile?.id, serverBrowser, setSignIn, signIn?.profileId, t, viewerId]);

  // Leaves without saving: the sign-in browser closes and the profile keeps
  // what it had.
  const cancelSignIn = React.useCallback(() => {
    if (!scope || !isSignInScope) return;
    void serverBrowser.closeScope(scope.id).finally(() => setSignIn(null));
  }, [isSignInScope, scope, serverBrowser, setSignIn]);

  const handleViewportChange = React.useCallback((next: BrowserViewport) => {
    setViewport(next);
    void serverBrowser.setViewport(toServiceViewport(next));
  }, [serverBrowser]);

  const zoomLevel = scope?.zoomLevel ?? 0;
  const zoomPercent = Math.round(1.2 ** zoomLevel * 100);

  const help = state?.help ?? null;
  const helpTargetsThisScope = Boolean(help && scope && (help.forScopeId ?? help.scopeId) === scope.id);

  const loaded = Boolean(showingMine && scope && scope.url && scope.url !== BLANK_URL);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      {isSignInScope && scope ? (
        <div className="flex items-center gap-2 border-b border-border bg-[var(--status-info-background)] px-3 py-1.5 typography-ui-label">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{t('contextPanel.browser.server.signingIn', { profile: scope.profile?.name ?? signIn?.name ?? '' })}</span>
            {' — '}
            {t('contextPanel.browser.server.help.loginHint')}
          </span>
          <Button size="xs" variant="ghost" onClick={cancelSignIn} disabled={savingSignIn}>
            {t('contextPanel.browser.server.cancel')}
          </Button>
          <Button size="xs" variant="outline" onClick={handleSaveSignIn} disabled={savingSignIn}>
            <Icon name="save-3" className="size-3.5" aria-hidden="true" />
            {t('contextPanel.browser.server.help.saveSignIn')}
          </Button>
        </div>
      ) : null}
      <BrowserToolbar
        address={address}
        onAddressChange={setAddress}
        onSubmit={(value) => {
          const next = normalizeBrowserUrl(value);
          if (next === BLANK_URL) return;
          void serverBrowser.navigate(next);
        }}
        suggestions={suggestions}
        onForgetSuggestion={(url) => forgetHistoryVisit(directory, url)}
        onBack={() => void serverBrowser.back()}
        onForward={() => void serverBrowser.forward()}
        onReload={() => void (scope?.isLoading ? serverBrowser.stop() : serverBrowser.reload())}
        onOpenExternal={() => void openExternalUrl(scope?.url || address)}
        canGoBack={scope?.canGoBack ?? false}
        canGoForward={scope?.canGoForward ?? false}
        isLoading={scope?.isLoading ?? false}
        onAnnotate={handleAnnotate}
        isAnnotating={isAnnotating}
        onToggleInspector={() => setInspectorOpen((current) => !current)}
        isInspectorOpen={inspectorOpen}
        onZoomIn={() => void serverBrowser.setZoom(Math.min(ZOOM_MAX, zoomLevel + 1))}
        onZoomOut={() => void serverBrowser.setZoom(Math.max(ZOOM_MIN, zoomLevel - 1))}
        onZoomReset={() => void serverBrowser.setZoom(0)}
        zoomPercent={zoomPercent}
        menuItems={[
          { kind: 'item', id: 'cookies', icon: 'delete-bin', label: t('contextPanel.browser.clearCookies'), onSelect: () => setClearConfirm('cookies') },
          { kind: 'item', id: 'cache', icon: 'database-2', label: t('contextPanel.browser.clearCache'), onSelect: () => setClearConfirm('cache') },
          { kind: 'item', id: 'external', icon: 'external-link', label: t('contextPanel.browser.openExternal'), onSelect: () => void openExternalUrl(scope?.url || address), disabled: !loaded },
          { kind: 'separator', id: 'sep' },
          { kind: 'item', id: 'close', icon: 'close-circle', label: t('contextPanel.browser.server.closeScope'), onSelect: closeChatBrowser, destructive: true, disabled: !scope },
        ]}
        onToggleDeviceBar={() => setShowDeviceBar((current) => !current)}
        isDeviceBarOpen={showDeviceBar}
      />
      {showDeviceBar ? (
        <BrowserDeviceBar
          viewport={viewport}
          onViewportChange={handleViewportChange}
          colorScheme="system"
          onColorSchemeChange={() => {}}
          scale={1}
        />
      ) : null}
      <ServerBrowserBanners
        control={control}
        connection={connection}
        focused={canvasFocused}
        onHandBack={() => canvasHandleRef.current?.release()}
        help={help}
        helpTargetsThisScope={helpTargetsThisScope}
        onSaveSignIn={handleSaveSignIn}
        savingSignIn={savingSignIn}
        chrome={state?.chrome ?? null}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ServerBrowserCanvas
          ref={canvasHandleRef}
          guestId={guestId}
          onViewer={setViewerId}
          onControl={setControl}
          onConnection={setConnection}
          onFocusChange={setCanvasFocused}
        />
        {!loaded && (showingMine || !serverBrowser.loading) ? (
          <div className="absolute inset-0">
            <BrowserEmptyState onOpen={(url) => void serverBrowser.navigate(normalizeBrowserUrl(url))} directory={directory} />
          </div>
        ) : null}
      </div>
      <ServerBrowserInspector guestId={guestId} viewerId={viewerId} open={inspectorOpen} />

      <Dialog open={clearConfirm !== null} onOpenChange={(open) => { if (!open) setClearConfirm(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>
              {clearConfirm === 'cookies' ? t('contextPanel.browser.clearCookies') : t('contextPanel.browser.clearCache')}
            </DialogTitle>
            <DialogDescription>
              {t('contextPanel.browser.server.clearConfirm', {
                what: clearConfirm === 'cookies' ? t('contextPanel.browser.clearCookies').toLowerCase() : t('contextPanel.browser.clearCache').toLowerCase(),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClearConfirm(null)}>{t('contextPanel.browser.server.cancel')}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const what = clearConfirm;
                setClearConfirm(null);
                if (!what) return;
                void serverBrowser.clearData(what).then(() => {
                  toast.success(t(what === 'cookies' ? 'contextPanel.browser.clearedCookies' : 'contextPanel.browser.clearedCache'));
                });
              }}
            >
              {clearConfirm === 'cookies' ? t('contextPanel.browser.clearCookies') : t('contextPanel.browser.clearCache')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
