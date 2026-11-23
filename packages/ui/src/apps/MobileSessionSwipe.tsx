import React from 'react';
import { RiArchiveLine, RiDeleteBinLine, RiEdit2Line } from '@remixicon/react';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const ROW_ACTION_SLOT_WIDTH = 48;

export const ROW_ACTIONS_WIDTH = 4 * ROW_ACTION_SLOT_WIDTH;

type MobileSessionWorkAction = { inWork: boolean; onToggle: () => void };
type MobileSessionPinAction = { pinned: boolean; onToggle: () => void };
type MobileSessionPriorityAction = { priority: boolean; onToggle: () => void };
const ROW_SWIPE_SNAP_MS = 180;

const setActionsShown = (actions: HTMLElement | null, shown: boolean) => {
  if (actions) actions.style.visibility = shown ? 'visible' : 'hidden';
};

export const MobileSwipeActionsRow: React.FC<{
  actionsWidth: number;
  actions: React.ReactNode;
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
  dataActiveSession?: boolean;
  sessionId?: string;
  contentClassName?: string;
  children: React.ReactNode;
}> = ({
  actionsWidth,
  actions,
  revealed,
  onRevealedChange,
  dataActiveSession,
  sessionId,
  contentClassName = 'relative flex w-full items-center bg-background',
  children,
}) => {
  const { direction } = useI18n();
  const sign = direction === 'rtl' ? -1 : 1;
  const contentRef = React.useRef<HTMLDivElement>(null);
  const actionsRef = React.useRef<HTMLDivElement>(null);
  const startRef = React.useRef<{ x: number; y: number; width: number } | null>(null);
  const draggingRef = React.useRef(false);
  const offsetRef = React.useRef(0);
  const revealedRef = React.useRef(revealed);

  const applyOffset = React.useCallback((px: number, animate: boolean) => {
    const el = contentRef.current;
    if (!el) return;
    setActionsShown(actionsRef.current, px !== 0 || (animate && px !== offsetRef.current));
    el.style.transition = animate ? `transform ${ROW_SWIPE_SNAP_MS}ms ease-out` : 'none';
    // CSS keeps an open strip within the row after a sidebar resize too.
    el.style.transform = px === 0 ? 'none' : `translateX(${sign === -1 ? 'max' : 'min'}(${px * sign}px, ${100 * sign}%))`;
    offsetRef.current = px;
  }, [sign]);

  const handleTransitionEnd = (event: React.TransitionEvent) => {
    if (event.target === contentRef.current && event.propertyName === 'transform' && offsetRef.current === 0) setActionsShown(actionsRef.current, false);
  };

  React.useLayoutEffect(() => {
    revealedRef.current = revealed;
    applyOffset(revealed ? actionsWidth : 0, true);
  }, [actionsWidth, applyOffset, revealed]);

  const handleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startRef.current = { x: touch.clientX, y: touch.clientY, width: Math.min(actionsWidth, event.currentTarget.clientWidth) };
    draggingRef.current = false;
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    if (!startRef.current) return;
    const touch = event.touches[0];
    const dx = (touch.clientX - startRef.current.x) * sign;
    const dy = touch.clientY - startRef.current.y;
    if (!draggingRef.current) {
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      draggingRef.current = true;
    }
    const width = startRef.current.width;
    const base = revealedRef.current ? width : 0;
    applyOffset(Math.max(0, Math.min(width, base + dx)), false);
  };

  const handleTouchEnd = () => {
    const start = startRef.current;
    startRef.current = null;
    if (!draggingRef.current || !start) return;
    draggingRef.current = false;
    const shouldReveal = offsetRef.current > start.width / 2;
    applyOffset(shouldReveal ? actionsWidth : 0, true);
    if (shouldReveal !== revealedRef.current) onRevealedChange(shouldReveal);
  };

  return (
    <div
      data-active-session={dataActiveSession || undefined}
      data-mobile-session-row={sessionId}
      className="relative oc-row-clip rounded-lg"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      style={{ touchAction: 'pan-y' }}
    >
      <div ref={actionsRef} className="absolute inset-y-0 inset-s-0 flex items-stretch" style={{ width: actionsWidth, maxWidth: '100%' }} aria-hidden={!revealed}>
        {actions}
      </div>
      <div ref={contentRef} className={`${contentClassName} rounded-[inherit]`} onTransitionEnd={handleTransitionEnd} onTransitionCancel={handleTransitionEnd}>
        {children}
      </div>
    </div>
  );
};

export const MobileSessionRowActions: React.FC<{
  sessionId: string;
  title: string;
  revealed: boolean;
  confirmingDelete: boolean;
  onArchive?: () => void;
  onRequestDelete?: () => void;
  onConfirmDelete?: () => void;
  onRequestRename?: () => void;
  onRevealedChange?: (revealed: boolean) => void;
  work?: MobileSessionWorkAction;
  pin?: MobileSessionPinAction;
  /** Mark as priority / Remove priority, on top-level rows. */
  priority?: MobileSessionPriorityAction;
}> = ({
  sessionId,
  title,
  revealed,
  confirmingDelete,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
  onRequestRename,
  onRevealedChange,
  work,
  pin,
  priority,
}) => {
  const { t } = useI18n();
  const tabIndex = revealed ? 0 : -1;

  const handleCopySessionId = async () => {
    const result = await copyTextToClipboard(sessionId).catch(() => null);
    if (!result?.ok) {
      toast.error(t('sessions.sidebar.session.copyId.error'));
      return;
    }

    onRevealedChange?.(false);
    toast.success(t('sessions.sidebar.session.copyId.success'));
  };

  return (
    <>
      <button
        type="button"
        tabIndex={tabIndex}
        className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={t('mobile.sessions.archiveSessionAria', { title })}
        onClick={onArchive}
        style={{ touchAction: 'manipulation' }}
      >
        <RiArchiveLine className="size-[18px]" />
      </button>
      {pin ? (
        <button
          type="button"
          tabIndex={tabIndex}
          className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={pin.pinned ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin')}
          onClick={() => { pin.onToggle(); onRevealedChange?.(false); }}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name={pin.pinned ? 'unpin' : 'pushpin'} className="size-[18px]" />
        </button>
      ) : null}
      {priority ? (
        <button
          type="button"
          tabIndex={tabIndex}
          className={cn(
            'flex flex-1 items-center justify-center transition-colors active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            priority.priority ? 'text-[var(--status-warning)]' : 'text-muted-foreground active:text-foreground',
          )}
          aria-label={priority.priority ? t('sessions.sidebar.session.menu.priorityOff') : t('sessions.sidebar.session.menu.priorityOn')}
          aria-pressed={priority.priority}
          onClick={() => { priority.onToggle(); onRevealedChange?.(false); }}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="flag" className="size-[18px]" />
        </button>
      ) : null}
      {work ? (
        <button
          type="button"
          tabIndex={tabIndex}
          className={cn(
            'flex flex-1 items-center justify-center transition-colors active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            work.inWork ? 'text-status-success' : 'text-muted-foreground active:text-foreground',
          )}
          aria-label={work.inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
          onClick={() => { work.onToggle(); onRevealedChange?.(false); }}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name={work.inWork ? 'check' : 'eye'} className={work.inWork ? 'size-5' : 'size-[18px]'} />
        </button>
      ) : null}
      <button
        type="button"
        tabIndex={tabIndex}
        className={cn(
          'flex flex-1 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive',
          confirmingDelete
            ? 'rounded-lg bg-destructive text-destructive-foreground'
            : 'text-[var(--status-error)] active:opacity-80',
        )}
        aria-label={confirmingDelete
          ? t('mobile.sessions.confirmDeleteSessionAria', { title })
          : t('mobile.sessions.deleteSessionAria', { title })}
        onClick={confirmingDelete ? onConfirmDelete : onRequestDelete}
        style={{ touchAction: 'manipulation' }}
      >
        <RiDeleteBinLine className="size-[18px]" />
      </button>
      <button
        type="button"
        tabIndex={tabIndex}
        className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={t('mobile.sessions.renameSessionAria', { title })}
        onClick={onRequestRename}
        style={{ touchAction: 'manipulation' }}
      >
        <RiEdit2Line className="size-[18px]" />
      </button>
      <button
        type="button"
        tabIndex={tabIndex}
        className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={t('sessions.sidebar.session.menu.copyId')}
        onClick={() => { void handleCopySessionId(); }}
        style={{ touchAction: 'manipulation' }}
      >
        <Icon name="file-copy" className="size-[18px]" />
      </button>
    </>
  );
};
