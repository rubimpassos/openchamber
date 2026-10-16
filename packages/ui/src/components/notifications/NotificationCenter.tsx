/**
 * The notification center: a bell with the unread count that opens the list of
 * every notification the server kept. Desktop and web open it as a popover
 * from the header; the mobile header opens it as a bottom sheet. Hidden while
 * the server has no center (an older build) and in VS Code, where there is no
 * OpenChamber server.
 */
import React from 'react';
import { Popover } from '@base-ui/react/popover';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import type { NotificationCenterEntry, NotificationCenterKind, NotificationCenterVerdict } from '@/lib/notificationCenter';
import { cn } from '@/lib/utils';
import { selectNotificationCenterUnread, useNotificationCenterStore } from '@/stores/useNotificationCenterStore';
import { openSessionFromToast } from '@/sync/session-navigation';

type Filter = 'all' | 'unread' | 'attention';

const FILTERS: Array<{ id: Filter; labelKey: I18nKey }> = [
  { id: 'all', labelKey: 'notificationCenter.filter.all' },
  { id: 'unread', labelKey: 'notificationCenter.filter.unread' },
  { id: 'attention', labelKey: 'notificationCenter.filter.attention' },
];

const KIND_ICON = {
  ready: 'chat-check',
  error: 'error-warning',
  question: 'question',
  permission: 'shield-keyhole',
  goal: 'flag',
  'browser-help': 'global',
  plugin: 'notification-3',
} as const satisfies Record<NotificationCenterKind, IconName>;

const KIND_LABEL = {
  ready: 'notificationCenter.kind.ready',
  error: 'notificationCenter.kind.error',
  question: 'notificationCenter.kind.question',
  permission: 'notificationCenter.kind.permission',
  goal: 'notificationCenter.kind.goal',
  'browser-help': 'notificationCenter.kind.browserHelp',
  plugin: 'notificationCenter.kind.plugin',
} as const satisfies Record<NotificationCenterKind, I18nKey>;

const VERDICT_LABEL = {
  review: 'notificationCenter.verdict.review',
  'stopped-midway': 'notificationCenter.verdict.stoppedMidway',
  'looks-done': 'notificationCenter.verdict.looksDone',
  trivial: 'notificationCenter.verdict.trivial',
} as const satisfies Record<NotificationCenterVerdict, I18nKey>;

const ATTENTION_KINDS = new Set<NotificationCenterKind>(['error', 'question', 'permission', 'browser-help']);

const matchesFilter = (entry: NotificationCenterEntry, filter: Filter): boolean => {
  if (filter === 'unread') return entry.readAt === null;
  if (filter === 'attention') return entry.readAt === null && ATTENTION_KINDS.has(entry.kind);
  return true;
};

const formatEntryTime = (createdAt: number): string => {
  const date = new Date(createdAt);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(getCurrentIntlLocale(), sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
};

const iconColor = (entry: NotificationCenterEntry): string => {
  if (entry.kind === 'error') return 'text-[var(--status-error)]';
  if (ATTENTION_KINDS.has(entry.kind)) return 'text-[var(--status-warning)]';
  if (entry.priority === 'low') return 'text-muted-foreground';
  return 'text-[var(--status-info)]';
};

const NotificationRow: React.FC<{ entry: NotificationCenterEntry; onOpen: (entry: NotificationCenterEntry) => void }> = ({ entry, onOpen }) => {
  const { t } = useI18n();
  const unread = entry.readAt === null;
  const meta = [
    entry.sessionName,
    entry.verdict ? t(VERDICT_LABEL[entry.verdict]) : null,
    entry.delivery === 'quiet' ? t('notificationCenter.delivery.quiet') : null,
  ].filter(Boolean).join(' · ');

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(entry)}
        className={cn(
          'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          entry.priority === 'low' && !unread && 'opacity-70',
        )}
      >
        <Icon name={KIND_ICON[entry.kind]} className={cn('mt-0.5 size-4 shrink-0', iconColor(entry))} aria-label={t(KIND_LABEL[entry.kind])} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span dir="auto" className={cn('min-w-0 flex-1 truncate typography-ui-label', unread ? 'text-foreground font-medium' : 'text-muted-foreground')}>
              {entry.title}
            </span>
            <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{formatEntryTime(entry.createdAt)}</span>
          </span>
          {entry.body ? (
            <span dir="auto" className="line-clamp-2 typography-meta text-muted-foreground">{entry.body}</span>
          ) : null}
          {meta ? <span dir="auto" className="truncate typography-micro text-muted-foreground/80">{meta}</span> : null}
        </span>
        {unread ? (
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--primary-base)]" aria-label={t('notificationCenter.filter.unread')} />
        ) : null}
      </button>
    </li>
  );
};

/** The list with its filters and actions; shared by the popover and the mobile sheet. */
const NotificationCenterContent: React.FC<{ onNavigate: () => void }> = ({ onNavigate }) => {
  const { t } = useI18n();
  const status = useNotificationCenterStore((state) => state.status);
  const entries = useNotificationCenterStore((state) => state.entries);
  const unread = useNotificationCenterStore(selectNotificationCenterUnread);
  const [filter, setFilter] = React.useState<Filter>('all');
  const visible = React.useMemo(() => entries.filter((entry) => matchesFilter(entry, filter)), [entries, filter]);

  const openEntry = React.useCallback((entry: NotificationCenterEntry) => {
    const { markRead } = useNotificationCenterStore.getState();
    if (entry.readAt === null) {
      void markRead({ ids: [entry.id] }).catch(() => toast.error(t('notificationCenter.toast.markReadFailed')));
    }
    if (entry.sessionId && entry.directory) {
      openSessionFromToast(entry.sessionId, entry.directory);
      onNavigate();
    }
  }, [onNavigate, t]);

  const markAllRead = () => {
    void useNotificationCenterStore.getState().markRead({ all: true })
      .catch(() => toast.error(t('notificationCenter.toast.markReadFailed')));
  };
  const clearAll = () => {
    void useNotificationCenterStore.getState().clear()
      .catch(() => toast.error(t('notificationCenter.toast.clearFailed')));
  };

  let body: React.ReactNode;
  if (status === 'error' && entries.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <p className="typography-meta text-muted-foreground">{t('notificationCenter.state.loadFailed')}</p>
        <Button size="xs" variant="outline" onClick={() => void useNotificationCenterStore.getState().load()}>
          {t('notificationCenter.action.retry')}
        </Button>
      </div>
    );
  } else if (status === 'loading' && entries.length === 0) {
    body = <p className="px-4 py-8 text-center typography-meta text-muted-foreground">{t('notificationCenter.state.loading')}</p>;
  } else if (visible.length === 0) {
    body = (
      <p className="px-4 py-8 text-center typography-meta text-muted-foreground">
        {entries.length === 0 ? t('notificationCenter.state.empty') : t('notificationCenter.state.emptyFiltered')}
      </p>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-0.5 p-1">
        {visible.map((entry) => <NotificationRow key={entry.id} entry={entry} onOpen={openEntry} />)}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pt-1 pb-2">
        {FILTERS.map((option) => (
          <Button
            key={option.id}
            size="xs"
            variant="chip"
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
          >
            {t(option.labelKey)}
          </Button>
        ))}
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" disabled={unread === 0} onClick={markAllRead} aria-label={t('notificationCenter.action.markAllRead')}>
              <Icon name="check-double" className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('notificationCenter.action.markAllRead')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" disabled={entries.length === 0} onClick={clearAll} aria-label={t('notificationCenter.action.clear')}>
              <Icon name="delete-bin" className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('notificationCenter.action.clear')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
};

const useCenterVisible = (): boolean => {
  const status = useNotificationCenterStore((state) => state.status);
  return status !== 'idle' && status !== 'unsupported';
};

const UnreadBadge: React.FC<{ count: number; className?: string }> = ({ count, className }) => (count > 0 ? (
  <span
    aria-hidden
    className={cn(
      'pointer-events-none absolute flex min-w-[1rem] items-center justify-center rounded-full bg-[var(--primary-base)] px-1 typography-micro font-semibold leading-4 text-[var(--primary-foreground)] tabular-nums',
      className,
    )}
  >
    {count > 99 ? '99+' : count}
  </span>
) : null);

/** Header bell for desktop and web. `buttonClassName` matches the neighbouring header buttons. */
export const NotificationCenterButton: React.FC<{ buttonClassName: string }> = ({ buttonClassName }) => {
  const { t } = useI18n();
  const visible = useCenterVisible();
  const unread = useNotificationCenterStore(selectNotificationCenterUnread);
  const [open, setOpen] = React.useState(false);
  if (!visible) return null;

  const label = unread > 0 ? t('notificationCenter.button.ariaUnread', { count: unread }) : t('notificationCenter.title');
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger aria-label={label} aria-pressed={open} className={cn(buttonClassName, 'relative', open && 'text-foreground')}>
            <Icon name="notification-3" className="h-4 w-4" />
            <UnreadBadge count={unread} className="-top-1.5 -end-2 h-4" />
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-[120]">
          <Popover.Popup aria-label={t('notificationCenter.title')} className={cn(dropdownMenuPopupClass, 'flex w-[24rem] max-w-[calc(100vw-2rem)] flex-col p-1')}>
            <div className="px-2.5 pt-1.5 pb-1 typography-ui-label font-medium text-foreground">{t('notificationCenter.title')}</div>
            <div className="flex max-h-[min(32rem,calc(var(--available-height)-2rem))] min-h-0 flex-col">
              <NotificationCenterContent onNavigate={() => setOpen(false)} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

/** Header bell for the mobile layout; the list opens as a bottom sheet. */
export const MobileNotificationCenterButton: React.FC<{ className: string; onOpen?: () => void }> = ({ className, onOpen }) => {
  const { t } = useI18n();
  const visible = useCenterVisible();
  const unread = useNotificationCenterStore(selectNotificationCenterUnread);
  const [open, setOpen] = React.useState(false);
  if (!visible) return null;

  const label = unread > 0 ? t('notificationCenter.button.ariaUnread', { count: unread }) : t('notificationCenter.title');
  return (
    <>
      <button
        type="button"
        className={cn(className, 'relative')}
        aria-label={label}
        aria-pressed={open}
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
        style={{ touchAction: 'manipulation' }}
      >
        <Icon name="notification-3" className="size-5" />
        <UnreadBadge count={unread} className="top-1 end-0.5 h-4" />
      </button>
      <MobileOverlayPanel open={open} title={t('notificationCenter.title')} onClose={() => setOpen(false)}>
        <NotificationCenterContent onNavigate={() => setOpen(false)} />
      </MobileOverlayPanel>
    </>
  );
};
