import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ApproveAction, IssueProvider, Suggestion, SuggestionFile, SuggestionSeverity } from '@/lib/suggestedTasksApi';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

export type SuggestionDecision =
  | { kind: 'approve'; action: ApproveAction; provider?: IssueProvider }
  | { kind: 'dismiss' }
  | { kind: 'snooze'; until: number }
  | { kind: 'restore' }
  | { kind: 'open-session' }
  | { kind: 'open-issue' };

const SEVERITY_TONE = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
  low: 'muted',
} satisfies Record<SuggestionSeverity, 'error' | 'warning' | 'info' | 'muted'>;

const SEVERITY_LABEL = {
  critical: 'suggestedTasks.severity.critical',
  high: 'suggestedTasks.severity.high',
  medium: 'suggestedTasks.severity.medium',
  low: 'suggestedTasks.severity.low',
} satisfies Record<SuggestionSeverity, I18nKey>;

const CONFIDENCE_LABEL = {
  high: 'suggestedTasks.confidence.high',
  medium: 'suggestedTasks.confidence.medium',
  low: 'suggestedTasks.confidence.low',
} satisfies Record<Suggestion['confidence'], I18nKey>;

const ISSUE_LABEL = {
  github: 'suggestedTasks.action.issueGitHub',
  gitlab: 'suggestedTasks.action.issueGitLab',
  linear: 'suggestedTasks.action.issueLinear',
} satisfies Record<IssueProvider, I18nKey>;

const CONVERSION_LABEL = {
  session: 'suggestedTasks.conversion.session',
  worktree: 'suggestedTasks.conversion.worktree',
  'draft-pr': 'suggestedTasks.conversion.draftPr',
  todo: 'suggestedTasks.conversion.todo',
  issue: 'suggestedTasks.conversion.issue',
  draft: 'suggestedTasks.conversion.draft',
} satisfies Record<NonNullable<Suggestion['conversion']>['kind'], I18nKey>;

const DAY_MS = 24 * 60 * 60 * 1000;

const fileLabel = (file: SuggestionFile): string => {
  if (!file.startLine) return file.path;
  return file.endLine ? `${file.path}:${file.startLine}-${file.endLine}` : `${file.path}:${file.startLine}`;
};

const toneStyle = (tone: 'error' | 'warning' | 'info' | 'muted'): React.CSSProperties | undefined => (
  tone === 'muted'
    ? undefined
    : { color: `var(--status-${tone})`, backgroundColor: `var(--status-${tone}-background)`, borderColor: `var(--status-${tone}-border)` }
);

/**
 * One suggestion: what to do and why, where in the code, which lens found
 * it and how sure it is, and what the user can do with it in its state.
 */
export const SuggestionCard: React.FC<{
  suggestion: Suggestion;
  projectPath: string;
  issueProviders: IssueProvider[];
  canCreateWorktree: boolean;
  busy: boolean;
  onDecide: (decision: SuggestionDecision) => void;
}> = ({ suggestion, projectPath, issueProviders, canCreateWorktree, busy, onDecide }) => {
  const { t } = useI18n();
  const timeFormat = useUIStore((state) => state.timeFormatPreference);
  const formatTime = (value: number) => formatDateTimeForPreference(value, timeFormat, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const openFile = (file: SuggestionFile) => {
    const absolute = `${projectPath.replace(/\/+$/, '')}/${file.path}`;
    if (file.startLine) useUIStore.getState().openContextFileAtLine(projectPath, absolute, file.startLine);
    else useUIStore.getState().openContextFile(projectPath, absolute);
  };

  const approveItems: Array<{ action: ApproveAction; icon: IconName; label: I18nKey; hidden?: boolean }> = [
    { action: 'session', icon: 'chat-new', label: 'suggestedTasks.action.session' },
    { action: 'worktree', icon: 'git-branch', label: 'suggestedTasks.action.worktree', hidden: !canCreateWorktree },
    { action: 'draft-pr', icon: 'git-pull-request', label: 'suggestedTasks.action.draftPr', hidden: !canCreateWorktree },
    { action: 'draft', icon: 'edit-2', label: 'suggestedTasks.action.draft' },
    { action: 'todo', icon: 'todo', label: 'suggestedTasks.action.todo' },
  ];

  const pending = suggestion.status === 'open' || suggestion.status === 'snoozed';
  const controlsDisabled = busy || Boolean(suggestion.conversionPending);
  const canRestore = suggestion.conversionPending ? Boolean(suggestion.conversionRecoverable) : suggestion.status === 'dismissed';
  const conversion = suggestion.conversion;

  return (
    <article className="rounded-lg border border-border p-4" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded border px-1.5 py-px font-medium" style={toneStyle(SEVERITY_TONE[suggestion.severity])}>
          {t(SEVERITY_LABEL[suggestion.severity])}
        </span>
        <span>{t(CONFIDENCE_LABEL[suggestion.confidence])}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex min-w-0 items-center gap-1">
          <Icon name="search-eye" className="size-3.5 shrink-0" />
          <span className="truncate" dir="auto">{suggestion.lensName}</span>
        </span>
        <span aria-hidden="true">·</span>
        <span>{formatTime(suggestion.createdAt)}</span>
      </div>

      <h3 className="mt-2 typography-ui-header font-semibold text-foreground oc-ui-start-align" dir="auto">{suggestion.title}</h3>
      {suggestion.body ? (
        <p className="mt-1.5 whitespace-pre-wrap break-words typography-meta text-muted-foreground oc-ui-start-align" dir="auto">{suggestion.body}</p>
      ) : null}

      {suggestion.files.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t('suggestedTasks.card.files')}>
          {suggestion.files.map((file) => (
            <li key={fileLabel(file)}>
              <button
                type="button"
                dir="ltr"
                onClick={() => openFile(file)}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5 font-mono typography-micro text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={t('suggestedTasks.card.openFile')}
              >
                <Icon name="file-text" className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{fileLabel(file)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {suggestion.status === 'dismissed' ? (
        <p className="mt-3 typography-meta text-muted-foreground" dir="auto">
          {suggestion.dismissReason
            ? t('suggestedTasks.card.dismissedWithReason', { reason: suggestion.dismissReason })
            : t('suggestedTasks.card.dismissed')}
        </p>
      ) : null}
      {suggestion.status === 'snoozed' && suggestion.snoozedUntil ? (
        <p className="mt-3 inline-flex items-center gap-1 typography-meta text-muted-foreground">
          <Icon name="timer" className="size-3.5" />
          {t('suggestedTasks.card.snoozedUntil', { time: formatTime(suggestion.snoozedUntil) })}
        </p>
      ) : null}
      {conversion ? (
        <p className="mt-3 inline-flex flex-wrap items-center gap-1 typography-meta text-muted-foreground">
          <Icon name="checkbox-circle" className="size-3.5" style={{ color: 'var(--status-success)' }} />
          {t(CONVERSION_LABEL[conversion.kind])}
          {conversion.auto ? <span>· {t('suggestedTasks.conversion.automatic')}</span> : null}
        </p>
      ) : null}
      {suggestion.conversionError ? (
        <p className="mt-2 typography-meta" style={{ color: 'var(--status-error)' }}>
          {t('suggestedTasks.card.automaticActionFailed', { error: suggestion.conversionError })}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {pending ? (
          <>
            <Button size="sm" disabled={controlsDisabled} onClick={() => onDecide({ kind: 'approve', action: 'session' })}>
              <Icon name="play" className="size-4" /> {t('suggestedTasks.action.session')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={controlsDisabled}>
                  {t('suggestedTasks.action.approveAs')}
                  <Icon name="arrow-down-s" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-56">
                {approveItems.filter((item) => !item.hidden).map((item) => (
                  <DropdownMenuItem key={item.action} disabled={controlsDisabled} onClick={() => onDecide({ kind: 'approve', action: item.action })}>
                    <Icon name={item.icon} className="size-4" />
                    {t(item.label)}
                  </DropdownMenuItem>
                ))}
                {issueProviders.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>{t('suggestedTasks.action.issueGroup')}</DropdownMenuLabel>
                    {issueProviders.map((provider) => (
                      <DropdownMenuItem key={provider} disabled={controlsDisabled} onClick={() => onDecide({ kind: 'approve', action: 'issue', provider })}>
                        <Icon name="external-link" className="size-4" />
                        {t(ISSUE_LABEL[provider])}
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" disabled={controlsDisabled}>
                  <Icon name="timer" className="size-4" /> {t('suggestedTasks.action.snooze')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem disabled={controlsDisabled} onClick={() => onDecide({ kind: 'snooze', until: Date.now() + DAY_MS })}>{t('suggestedTasks.snooze.day')}</DropdownMenuItem>
                <DropdownMenuItem disabled={controlsDisabled} onClick={() => onDecide({ kind: 'snooze', until: Date.now() + 7 * DAY_MS })}>{t('suggestedTasks.snooze.week')}</DropdownMenuItem>
                <DropdownMenuItem disabled={controlsDisabled} onClick={() => onDecide({ kind: 'snooze', until: Date.now() + 30 * DAY_MS })}>{t('suggestedTasks.snooze.month')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => onDecide({ kind: 'dismiss' })}>
              <Icon name="close-circle" className="size-4" /> {t('suggestedTasks.action.dismiss')}
            </Button>
            {suggestion.status === 'snoozed' ? (
              <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => onDecide({ kind: 'restore' })}>
                {t('suggestedTasks.action.wake')}
              </Button>
            ) : null}
          </>
        ) : null}
        {conversion?.sessionId ? (
          <Button size="sm" variant="outline" onClick={() => onDecide({ kind: 'open-session' })}>
            <Icon name="chat-1" className="size-4" /> {t('suggestedTasks.action.openSession')}
          </Button>
        ) : null}
        {conversion?.url ? (
          <Button size="sm" variant="outline" onClick={() => onDecide({ kind: 'open-issue' })}>
            <Icon name="external-link" className="size-4" /> {t('suggestedTasks.action.openIssueForm')}
          </Button>
        ) : null}
        {canRestore ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide({ kind: 'restore' })}>
            <Icon name="arrow-go-back" className={cn('size-4')} /> {t('suggestedTasks.action.restore')}
          </Button>
        ) : null}
      </div>
    </article>
  );
};
