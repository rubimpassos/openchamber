import React, { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useComposerStatusChip } from '@/components/chat/composer/state/composerStatusChips';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSessionSelection } from './chatColumnSession';
import { isVSCodeRuntime } from '@/lib/desktop';
import { prFixLoopStore, usePrFixLoopProjection, usePrFixLoopStore } from '@/stores/usePrFixLoopStore';
import { PrFixLoopRow } from './PrFixLoopRow';

/**
 * Review and server-owned PR fix loops share the composer's existing loop strip.
 */
export const AutoReviewStrip = memo(() => {
  const { t } = useI18n();
  const currentSessionId = useChatSessionSelection().sessionId;
  const run = useAutoReviewStore(React.useCallback((state) => {
    if (!currentSessionId) return null;
    const run = state.runsByOriginalSessionID[currentSessionId] ?? null;
    return run?.runtimeKey === getRuntimeKey() ? run : null;
  }, [currentSessionId]));
  const stopRun = useAutoReviewStore((state) => state.stopRun);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const supported = !isVSCodeRuntime();
  usePrFixLoopProjection(supported && Boolean(currentSessionId));
  const loops = usePrFixLoopStore(useShallow((state) => supported && state.runtimeKey === getRuntimeKey()
    ? state.loops.filter((loop) => loop.sessionId === currentSessionId) : []));
  const projectionFailed = usePrFixLoopStore((state) => supported && state.loadError !== null);
  const reviewing = run?.status === 'running';
  const visible = Boolean(currentSessionId && (reviewing || loops.length || projectionFailed));

  useComposerStatusChip('autoReview', visible
    ? { icon: reviewing ? 'loader-4' : 'git-pull-request', label: t(reviewing ? 'chat.autoReview.title' : 'prFixLoop.title'), spin: reviewing }
    : null);

  if (!visible) {
    return null;
  }

  const statusLabel = run?.phase === 'waiting_for_reviewer'
    ? t('chat.autoReview.status.waitingForReviewer')
    : t('chat.autoReview.status.waitingForImplementer');

  const handleOpenReviewSession = () => {
    if (!run) return;
    openContextPanelTab(run.directory, {
      mode: 'chat',
      dedupeKey: `session:${run.reviewSessionID}`,
      label: t('chat.autoReview.reviewSessionLabel'),
      readOnly: true,
    });
  };

  return (
    <div className="min-w-0">
      {reviewing && currentSessionId ? (
    <div role="status" className="flex h-10 min-w-0 items-center gap-2 border-b border-border/60 ps-3 pe-1.5">
      <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {t('chat.autoReview.title')}
        <span className="text-muted-foreground"> · {statusLabel}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleOpenReviewSession}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        {t('chat.autoReview.actions.open')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => stopRun(currentSessionId)}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-status-error/80 hover:bg-transparent hover:text-status-error"
      >
        {t('chat.autoReview.actions.stop')}
      </Button>
    </div>
      ) : null}
      {projectionFailed ? <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 typography-meta text-status-warning">
        <span>{t('prFixLoop.error.load')}</span>
        <Button variant="ghost" size="sm" onClick={() => void prFixLoopStore.getState().refresh()}>{t('prFixLoop.action.retry')}</Button>
      </div> : null}
      <div className="max-h-60 overflow-y-auto">
        {loops.map((loop) => <PrFixLoopRow key={loop.id} loop={loop} projectionFailed={projectionFailed} />)}
      </div>
    </div>
  );
});

AutoReviewStrip.displayName = 'AutoReviewStrip';
