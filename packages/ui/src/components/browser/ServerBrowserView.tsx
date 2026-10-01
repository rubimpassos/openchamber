import React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
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
import { closeServerBrowserProfile } from '@/lib/browser/serverBrowser/client';
import { useServerBrowserConnection } from '@/lib/browser/serverBrowser/useServerBrowserConnection';
import type { SurfaceConnectionState, SurfaceControlState } from '@/lib/guests/surface-client';

import { BrowserToolbar } from './BrowserToolbar';
import { BrowserDeviceBar } from './BrowserDeviceBar';
import { BrowserEmptyState } from './BrowserEmptyState';
import { useAnnotationAttach, useAnnotationOverlayLabels } from './useAnnotationAttach';
import { ServerBrowserCanvas, type ServerBrowserCanvasHandle } from './ServerBrowserCanvas';
import { ServerBrowserHeader } from './ServerBrowserHeader';
import { ServerBrowserBanners } from './ServerBrowserBanners';
import { ServerBrowserTabs } from './ServerBrowserTabs';
import { ServerBrowserInspector } from './ServerBrowserInspector';

export type ServerBrowserViewProps = {
  guestId: string;
  directory: string;
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
export const ServerBrowserView: React.FC<ServerBrowserViewProps> = ({ guestId, directory }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const canvasHandleRef = React.useRef<ServerBrowserCanvasHandle | null>(null);

  const [viewerId, setViewerId] = React.useState<string | undefined>(undefined);
  const [control, setControl] = React.useState<SurfaceControlState>({ controller: 'none', mine: false });
  const [connection, setConnection] = React.useState<SurfaceConnectionState>({ status: 'connecting' });
  const [canvasFocused, setCanvasFocused] = React.useState(false);

  const serverBrowser = useServerBrowserConnection(guestId, directory, viewerId);
  const { scope, state } = serverBrowser;

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
          void serverBrowser.refresh();
        } else {
          toast.error(t('contextPanel.browser.server.help.saveSignInFailed'));
        }
      })
      .finally(() => setSavingSignIn(false));
  }, [guestId, scope?.profile?.id, serverBrowser, t, viewerId]);

  const handleViewportChange = React.useCallback((next: BrowserViewport) => {
    setViewport(next);
    void serverBrowser.setViewport(toServiceViewport(next));
  }, [serverBrowser]);

  const zoomLevel = scope?.zoomLevel ?? 0;
  const zoomPercent = Math.round(1.2 ** zoomLevel * 100);

  const help = state?.help ?? null;
  const helpTargetsThisScope = Boolean(help && scope && (help.forScopeId ?? help.scopeId) === scope.id);

  const loaded = Boolean(scope && scope.url && scope.url !== BLANK_URL);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <ServerBrowserHeader
        scope={scope}
        allScopes={state?.scopes ?? []}
        onSelectScope={(scopeId) => void serverBrowser.selectScope(scopeId)}
        onCloseScope={(scopeId) => void serverBrowser.closeScope(scopeId)}
      />
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
        onClearCookies={() => setClearConfirm('cookies')}
        onClearCache={() => setClearConfirm('cache')}
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
      <ServerBrowserTabs
        tabs={scope?.tabs ?? []}
        onSelect={(tabId) => void serverBrowser.selectTab(tabId)}
        onClose={(tabId) => void serverBrowser.closeTab(tabId)}
        onNew={() => void serverBrowser.newTab()}
      />
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
      <div className="relative min-h-0 flex-1">
        <ServerBrowserCanvas
          ref={canvasHandleRef}
          guestId={guestId}
          onViewer={setViewerId}
          onControl={setControl}
          onConnection={setConnection}
          onFocusChange={setCanvasFocused}
        />
        {!loaded && !serverBrowser.loading ? (
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
