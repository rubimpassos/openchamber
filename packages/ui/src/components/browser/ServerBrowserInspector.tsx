import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  clearServerBrowserInspector,
  getServerBrowserInspectorRequest,
  pollServerBrowserInspector,
  startServerBrowserInspector,
  stopServerBrowserInspector,
} from '@/lib/browser/serverBrowser/client';
import type {
  ServerBrowserConsoleRow,
  ServerBrowserNetworkRow,
  ServerBrowserRequestDetail,
} from '@/lib/browser/serverBrowser/types';

/**
 * Console and network rows for the visible tab, in place of embedded
 * DevTools: the service captures them (see the standalone extension's
 * `panel/inspector.js`, ported server-side) and this polls for new ones with
 * a cursor, same as that page did.
 */

const POLL_MS = 700;

type InspectorTab = 'console' | 'network';

const levelTone = (level: string): string => {
  if (level === 'error') return 'text-[var(--status-error)]';
  if (level === 'warning') return 'text-[var(--status-warning)]';
  return 'text-foreground';
};

const statusTone = (row: ServerBrowserNetworkRow): string => {
  if (row.state === 'failed' || (row.status !== null && row.status >= 400)) return 'text-[var(--status-error)]';
  if (row.state === 'pending') return 'text-muted-foreground';
  return 'text-foreground';
};

export const ServerBrowserInspector: React.FC<{
  guestId: string;
  viewerId: string | undefined;
  open: boolean;
}> = ({ guestId, viewerId, open }) => {
  const { t } = useI18n();
  const [tab, setTab] = React.useState<InspectorTab>('console');
  const [consoleRows, setConsoleRows] = React.useState<ServerBrowserConsoleRow[]>([]);
  const [networkRows, setNetworkRows] = React.useState<ServerBrowserNetworkRow[]>([]);
  const [selectedEntryId, setSelectedEntryId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<ServerBrowserRequestDetail | null>(null);
  const captureIdRef = React.useRef<string | null>(null);
  const cursorRef = React.useRef(0);

  const mergeRows = <T extends { id: string }>(current: T[], incoming: readonly T[]): T[] => {
    if (incoming.length === 0) return current;
    const byId = new Map(current.map((row) => [row.id, row]));
    for (const row of incoming) byId.set(row.id, row);
    return Array.from(byId.values());
  };

  React.useEffect(() => {
    if (!open || viewerId === undefined) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      const captureId = captureIdRef.current;
      if (!captureId || disposed) return;
      const result = await pollServerBrowserInspector(guestId, viewerId, captureId, cursorRef.current);
      if (disposed || !result.ok) return;
      cursorRef.current = result.data.cursor;
      if (result.data.console.length) setConsoleRows((current) => mergeRows(current, result.data.console));
      if (result.data.network.length) setNetworkRows((current) => mergeRows(current, result.data.network));
      timer = setTimeout(poll, POLL_MS);
    };

    void startServerBrowserInspector(guestId, viewerId).then((result) => {
      if (disposed || !result.ok) return;
      captureIdRef.current = result.data.captureId;
      cursorRef.current = 0;
      setConsoleRows([]);
      setNetworkRows([]);
      timer = setTimeout(poll, POLL_MS);
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      const captureId = captureIdRef.current;
      captureIdRef.current = null;
      if (captureId) void stopServerBrowserInspector(guestId, viewerId, captureId);
    };
  }, [guestId, open, viewerId]);

  React.useEffect(() => {
    if (!selectedEntryId || !captureIdRef.current || viewerId === undefined) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void getServerBrowserInspectorRequest(guestId, viewerId, {
      captureId: captureIdRef.current,
      entryId: selectedEntryId,
      includeBody: true,
    }).then((result) => {
      if (!cancelled && result.ok) setDetail(result.data);
    });
    return () => { cancelled = true; };
  }, [guestId, selectedEntryId, viewerId]);

  const handleClear = React.useCallback(() => {
    const captureId = captureIdRef.current;
    if (!captureId || viewerId === undefined) return;
    void clearServerBrowserInspector(guestId, viewerId, { captureId, scope: tab });
    if (tab === 'console') setConsoleRows([]);
    else { setNetworkRows([]); setSelectedEntryId(null); }
  }, [guestId, tab, viewerId]);

  if (!open) return null;

  return (
    <div className="flex h-56 shrink-0 flex-col border-t border-border bg-[var(--surface-background)]">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {(['console', 'network'] as const).map((entry) => (
          <Button
            key={entry}
            type="button"
            variant={tab === entry ? 'secondary' : 'ghost'}
            size="xs"
            className="rounded-full px-2.5 typography-micro"
            onClick={() => setTab(entry)}
          >
            {t(entry === 'console' ? 'contextPanel.browser.server.inspector.console' : 'contextPanel.browser.server.inspector.network')}
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto w-6 shrink-0 rounded-full px-0 text-muted-foreground hover:text-foreground"
          onClick={handleClear}
          aria-label={t('contextPanel.browser.server.inspector.clear')}
        >
          <Icon name="delete-bin" className="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto font-mono typography-micro">
          {tab === 'console' ? (
            consoleRows.length === 0 ? (
              <div className="p-3 text-center text-muted-foreground">{t('contextPanel.browser.server.inspector.consoleEmpty')}</div>
            ) : (
              consoleRows.map((row) => (
                <div key={row.id} className={cn('border-b border-border/40 px-2 py-1', levelTone(row.level))}>
                  <span className="whitespace-pre-wrap break-words">{row.text}</span>
                  {row.source ? <span className="ml-2 text-muted-foreground">{row.source}</span> : null}
                </div>
              ))
            )
          ) : networkRows.length === 0 ? (
            <div className="p-3 text-center text-muted-foreground">{t('contextPanel.browser.server.inspector.networkEmpty')}</div>
          ) : (
            networkRows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelectedEntryId(row.id)}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-border/40 px-2 py-1 text-left hover:bg-[var(--interactive-hover)]',
                  selectedEntryId === row.id && 'bg-[var(--interactive-selection)]',
                )}
              >
                <span className={cn('w-8 shrink-0', statusTone(row))}>{row.status ?? (row.state === 'pending' ? '…' : '—')}</span>
                <span className="w-14 shrink-0 text-muted-foreground">{row.method}</span>
                <span className="min-w-0 flex-1 truncate">{row.url}</span>
                {row.durationMs !== null ? (
                  <span className="shrink-0 text-muted-foreground">{Math.round(row.durationMs)}ms</span>
                ) : null}
              </button>
            ))
          )}
        </div>

        {tab === 'network' && detail ? (
          <div className="w-64 shrink-0 overflow-auto border-l border-border p-2 font-mono typography-micro">
            <div className="mb-2 typography-meta font-sans text-foreground">{t('contextPanel.browser.server.inspector.requestDetails')}</div>
            <div className="mb-1 break-words text-muted-foreground">{detail.row.url}</div>
            <div className="mb-2 text-muted-foreground">{t('contextPanel.browser.server.inspector.redacted')}</div>
            {detail.requestHeaders.map((header) => (
              <div key={`req-${header.name}`} className="truncate">
                <span className="text-muted-foreground">{header.name}: </span>
                {header.value}
              </div>
            ))}
            {detail.responseHeaders.length > 0 ? (
              <div className="mt-2 border-t border-border/40 pt-2">
                {detail.responseHeaders.map((header) => (
                  <div key={`res-${header.name}`} className="truncate">
                    <span className="text-muted-foreground">{header.name}: </span>
                    {header.value}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
