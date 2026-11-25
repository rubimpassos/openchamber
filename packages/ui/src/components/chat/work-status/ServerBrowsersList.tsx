import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { isDockAccessError } from '@/components/sections/browser/serverBrowserApi';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { MonitoredBrowser } from '@/lib/browser/serverBrowser/monitoredBrowsers';
import { panelTabsByChromeTab, useServerBrowserPanelTabs } from '@/lib/browser/serverBrowser/panelTabs';
import type { ServerBrowserMonitorView } from '@/lib/browser/serverBrowser/useServerBrowserMonitor';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { WorkStatusCollapsibleSection, WorkStatusNote, WorkStatusRow } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import {
  BROWSER_ROW_LOOK,
  browserPage,
  browserRowStatus,
  formatBrowserMemory,
  orderBrowserRows,
  totalBrowserMemory,
} from './serverBrowserRows';
import { WorkStatusTouchContext } from './touchContext';

const SECTION_ID = 'browsers';

const closeBrowserTabs = (directory: string, browser: MonitoredBrowser): void => {
  const panelTabs = useServerBrowserPanelTabs.getState();
  const claimed = new Set(panelTabsByChromeTab(panelTabs.claims, browser.scopeId).values());
  for (const panelTabId of claimed) panelTabs.release(browser.scopeId, panelTabId);
  const ui = useUIStore.getState();
  const key = normalizeContextPanelDirectoryKey(directory);
  const panel = ui.contextPanelByDirectory[key];
  const owned = [...(panel?.tabs ?? []), ...(panel?.parkedBrowserTabs ?? [])]
    .filter((tab) => tab.mode === 'browser' && (browser.sessionId !== null && tab.ownerSessionId === browser.sessionId
      || tab.ownerSessionId === null && claimed.has(tab.id)))
    .map((tab) => tab.id);
  ui.closeContextPanelTabs(key, owned);
};

const ServerBrowserRow: React.FC<{
  browser: MonitoredBrowser;
  memoryBytes: number | null;
  memorySampledAt: number | null;
  closing: boolean;
  onClose: (browser: MonitoredBrowser, name: string) => void;
}> = ({ browser, memoryBytes, memorySampledAt, closing, onClose }) => {
  const { t } = useI18n();
  const touch = React.useContext(WorkStatusTouchContext);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const sessionId = browser.sessionId;
  const title = useGlobalSessionsStore(React.useCallback(
    (state) => (sessionId ? state.entityById.get(sessionId)?.title : undefined),
    [sessionId],
  ));
  const name = title?.trim() || t('sessions.sidebar.session.untitled');
  const status = browserRowStatus(browser);
  const look = BROWSER_ROW_LOOK[status];
  const statusLabel = look.labelKey ? t(look.labelKey) : null;
  const page = browserPage(browser) ?? t('chat.workStatus.browsers.blankPage');
  const reason = status === 'needsYou' ? browser.helpReason : status === 'failed' ? browser.lastError : null;
  const memory = memoryBytes === null ? null : formatBrowserMemory(memoryBytes, getCurrentIntlLocale());

  return (
    <WorkStatusRow
      className="group/browser"
      leading={(
        <span className="flex size-[13px] shrink-0 items-center justify-center">
          {status === 'loading'
            ? <Spinner className="size-3 text-muted-foreground" />
            : <Icon name={look.icon} className={cn('size-3', !look.color && 'text-muted-foreground')} style={look.color ? { color: look.color } : undefined} />}
        </span>
      )}
      label={<span className={status === 'idle' ? 'oc-title-rest' : 'text-foreground'}>{name}</span>}
      labelDir="auto"
      detail={reason ? (
        <span dir="auto" className="oc-ui-start-align block truncate">{reason}</span>
      ) : (
        <span className="flex min-w-0 items-baseline gap-1">
          {statusLabel ? <span className="shrink-0">{statusLabel}</span> : null}
          {statusLabel ? <span aria-hidden className="shrink-0">·</span> : null}
          <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate">{page}</span>
        </span>
      )}
      tooltip={(
        <span className="flex flex-col gap-0.5">
          {statusLabel ? <span>{statusLabel}</span> : null}
          {reason ? <span dir="auto">{reason}</span> : null}
          <span dir="auto">{page}</span>
          {browser.title.trim() && browser.url ? <span dir="ltr" className="break-all">{browser.url}</span> : null}
          <span>{t('chat.workStatus.browsers.tabs', { count: browser.tabCount })}</span>
          {browser.lastActiveMinute !== null ? (
            <span>{t('chat.workStatus.browsers.lastUsed', { time: formatTimeForPreference(browser.lastActiveMinute, timeFormatPreference) })}</span>
          ) : null}
          {browser.consoleErrors > 0 ? <span>{t('chat.workStatus.browsers.consoleErrors', { count: browser.consoleErrors })}</span> : null}
          {browser.consoleWarnings > 0 ? <span>{t('chat.workStatus.browsers.consoleWarnings', { count: browser.consoleWarnings })}</span> : null}
          {memory && memorySampledAt !== null ? (
            <span>{t('chat.workStatus.browsers.memory', { time: formatTimeForPreference(memorySampledAt, timeFormatPreference), memory })}</span>
          ) : null}
        </span>
      )}
      value={(
        <>
          {memory ? <span dir="ltr" className="text-[0.6875rem] leading-4 text-muted-foreground">{memory}</span> : null}
          <button
            type="button"
            disabled={closing}
            aria-label={t('chat.workStatus.browsers.close.aria', { name })}
            onClick={() => onClose(browser, name)}
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:text-foreground disabled:cursor-not-allowed',
              touch ? '-me-1.5 size-9' : 'size-5 focus-visible:opacity-100 group-hover/browser:opacity-100',
              !touch && !closing && 'opacity-0',
            )}
          >
            {closing ? <Spinner className={touch ? 'size-4' : 'size-[13px]'} /> : <Icon name="close" className={touch ? 'size-4' : 'size-[13px]'} />}
          </button>
        </>
      )}
    />
  );
};

export const ServerBrowsersList: React.FC<{
  monitor: ServerBrowserMonitorView;
  sessionId: string | null;
  directory: string | null;
}> = ({ monitor, sessionId, directory }) => {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const [closingId, setClosingId] = React.useState<string | null>(null);

  const rows = orderBrowserRows(monitor.browsers, sessionId);
  const shown = rows.length > 0 || monitor.readFailed;
  useReportWorkStatusPresence(SECTION_ID, shown);

  const handleClose = async (browser: MonitoredBrowser, name: string): Promise<void> => {
    const agreed = await confirm({
      title: t('chat.workStatus.browsers.close.title'),
      message: t('chat.workStatus.browsers.close.message', { name }),
      action: t('chat.workStatus.browsers.close'),
      destructive: true,
    });
    if (!agreed) return;
    setClosingId(browser.scopeId);
    const result = await monitor.close(browser.scopeId);
    setClosingId((current) => (current === browser.scopeId ? null : current));
    if (result.ok) {
      if (directory) closeBrowserTabs(directory, browser);
      return;
    }
    if (result.status === 404) {
      monitor.refresh();
      return;
    }
    toast.error(isDockAccessError(result.error)
      ? t('chat.workStatus.browsers.close.inUse')
      : t('chat.workStatus.browsers.close.failed', { reason: result.error }));
  };

  if (!shown) return null;

  const total = totalBrowserMemory(rows, monitor.memory);

  return (
    <WorkStatusCollapsibleSection
      id={SECTION_ID}
      title={t('chat.workStatus.section.browsers')}
      icon="global"
      defaultExpanded
      summary={total === null ? rows.length : formatBrowserMemory(total, getCurrentIntlLocale())}
      action={(
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
                onClick={monitor.refresh}
                aria-label={t('chat.workStatus.browsers.refresh')}
                disabled={monitor.refreshing}
              >
                <Icon name="refresh" className={cn('size-[13px]', monitor.refreshing && 'animate-spin')} />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{t('chat.workStatus.browsers.refresh')}</TooltipContent>
        </Tooltip>
      )}
    >
      {rows.map((browser) => (
        <ServerBrowserRow
          key={browser.scopeId}
          browser={browser}
          memoryBytes={monitor.memory?.bytesByScope.get(browser.scopeId) ?? null}
          memorySampledAt={monitor.memory?.sampledAt ?? null}
          closing={closingId === browser.scopeId}
          onClose={(target, name) => { void handleClose(target, name); }}
        />
      ))}
      {monitor.readFailed ? <WorkStatusNote>{t('chat.workStatus.browsers.readFailed')}</WorkStatusNote> : null}
      {dialog}
    </WorkStatusCollapsibleSection>
  );
};
