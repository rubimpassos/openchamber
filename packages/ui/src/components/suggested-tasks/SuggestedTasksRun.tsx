import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { LensRun, ScanRun } from '@/lib/suggestedTasksApi';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

const RUN_STATUS = {
  running: { label: 'suggestedTasks.run.status.running', icon: 'loader-4', tone: 'warning' },
  done: { label: 'suggestedTasks.run.status.done', icon: 'checkbox-circle', tone: 'success' },
  partial: { label: 'suggestedTasks.run.status.partial', icon: 'error-warning', tone: 'warning' },
  failed: { label: 'suggestedTasks.run.status.failed', icon: 'error-warning', tone: 'error' },
  skipped: { label: 'suggestedTasks.run.status.skipped', icon: 'timer', tone: null },
} satisfies Record<ScanRun['status'], { label: I18nKey; icon: IconName; tone: string | null }>;
const SKIP_REASON = {
  'quiet-hours': 'suggestedTasks.run.skipped.quietHours', 'no-changes': 'suggestedTasks.run.skipped.noChanges',
  'no-lenses': 'suggestedTasks.run.skipped.noLenses', disabled: 'suggestedTasks.run.skipped.disabled',
} satisfies Record<NonNullable<ScanRun['skipped']>, I18nKey>;
const LENS_STATUS = {
  pending: { label: 'suggestedTasks.run.lens.running', icon: 'timer', tone: 'warning' },
  running: { label: 'suggestedTasks.run.lens.running', icon: 'loader-4', tone: 'warning' },
  done: { label: 'suggestedTasks.run.lens.done', icon: 'checkbox-circle', tone: 'success' },
  failed: { label: 'suggestedTasks.run.lens.failed', icon: 'error-warning', tone: 'error' },
  stopped: { label: 'suggestedTasks.run.lens.stopped', icon: 'error-warning', tone: 'warning' },
} satisfies Record<LensRun['status'], { label: I18nKey; icon: IconName; tone: string | null }>;

export const SuggestedTasksRun: React.FC<{ run: ScanRun; onOpenSession: (lens: LensRun) => void; onStop: () => void }> = ({ run, onOpenSession, onStop }) => {
  const { t } = useI18n();
  const timeFormat = useUIStore((state) => state.timeFormatPreference);
  const status = RUN_STATUS[run.status];
  const added = run.lenses.reduce((sum, lens) => sum + lens.added, 0);
  return (
    <section className="rounded-lg border border-border p-3" aria-label={t('suggestedTasks.run.title')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta">
        <span className="inline-flex items-center gap-1 font-medium" style={status.tone ? { color: `var(--status-${status.tone})` } : undefined}>
          <Icon name={status.icon} className={cn('size-3.5', run.status === 'running' && 'animate-spin')} /> {t(status.label)}
        </span>
        <span className="text-muted-foreground">
          {formatDateTimeForPreference(run.startedAt, timeFormat, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          {' · '}{run.reason === 'manual' ? t('suggestedTasks.run.manual') : t('suggestedTasks.run.scheduled')}
        </span>
        {run.status !== 'skipped' && run.status !== 'running' ? <span className="text-muted-foreground">{t('suggestedTasks.run.added', { count: added })}</span> : null}
        {run.skipped ? <span className="text-muted-foreground">{t(SKIP_REASON[run.skipped])}</span> : null}
        {run.status === 'running' ? <Button size="xs" variant="ghost" className="ms-auto" onClick={onStop}>{t('suggestedTasks.run.stop')}</Button> : null}
      </div>
      {run.error ? <p role="alert" className="mt-2 typography-meta text-[var(--status-error)]">{run.error}</p> : null}
      {run.warnings?.map((warning) => <p key={warning} className="mt-2 typography-meta text-[var(--status-warning)]">{warning}</p>)}
      {run.lenses.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {run.lenses.map((lens) => {
            const meta = LENS_STATUS[lens.status];
            return (
              <li key={`${lens.lensId}:${lens.startedAt}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground">
                <Icon name={meta.icon} className={cn('size-3.5', lens.status === 'running' && 'animate-spin')} style={meta.tone ? { color: `var(--status-${meta.tone})` } : undefined} />
                <span className="font-medium text-foreground oc-ui-start-align" dir="auto">{lens.lensName}</span><span>{t(meta.label)}</span>
                {lens.status === 'done' || lens.reported > 0 ? <span>{t('suggestedTasks.run.lens.counts', { added: lens.added, reported: lens.reported })}</span> : null}
                {lens.error ? <span style={{ color: 'var(--status-error)' }}>{lens.error}</span> : null}
                {lens.sessionId ? <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpenSession(lens)}>{t('suggestedTasks.run.lens.openSession')}</button> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
};
