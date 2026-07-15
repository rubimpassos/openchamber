import React from 'react';
import { toast } from '@/components/ui';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { CiLoopSessionResult, CiLoopWatch, CiLoopWorkflowRun } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

const CI_LOOP_POLL_INTERVAL_MS = 5_000;

const CLEAN_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

const isCleanRun = (run: CiLoopWorkflowRun): boolean =>
  run.conclusion !== null && CLEAN_CONCLUSIONS.has(run.conclusion);

type PhaseView = {
  text: string;
  colorVar: string;
  iconName: IconName;
  spinning: boolean;
};

const usePhaseView = (watch: CiLoopWatch | null): PhaseView | null => {
  const { t } = useI18n();
  return React.useMemo(() => {
    if (!watch) {
      return null;
    }
    const phase = watch.phase;
    switch (phase.kind) {
      case 'waiting':
        return {
          text: t('gitView.ciLoop.phase.waiting'),
          colorVar: 'var(--status-info)',
          iconName: 'loader-4',
          spinning: true,
        };
      case 'running': {
        const completed = phase.runs.filter((run) => run.status === 'completed').length;
        return {
          text: t('gitView.ciLoop.phase.running', { completed, total: phase.runs.length }),
          colorVar: 'var(--status-info)',
          iconName: 'loader-4',
          spinning: true,
        };
      }
      case 'done': {
        const clean = phase.report.runs.every(isCleanRun);
        return clean
          ? {
              text: t('gitView.ciLoop.phase.doneClean'),
              colorVar: 'var(--status-success)',
              iconName: 'checkbox-circle',
              spinning: false,
            }
          : {
              text: t('gitView.ciLoop.phase.doneFailed'),
              colorVar: 'var(--status-error)',
              iconName: 'close-circle',
              spinning: false,
            };
      }
      case 'timed-out':
        return {
          text: t('gitView.ciLoop.phase.timedOut'),
          colorVar: 'var(--status-warning)',
          iconName: 'alert',
          spinning: false,
        };
      case 'error':
        return {
          text: t('gitView.ciLoop.phase.error', { message: phase.message }),
          colorVar: 'var(--status-error)',
          iconName: 'error-warning',
          spinning: false,
        };
      default:
        return null;
    }
  }, [t, watch]);
};

export const CiLoopSection: React.FC = () => {
  const { t } = useI18n();
  const { ciLoop } = useRuntimeAPIs();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

  const [result, setResult] = React.useState<CiLoopSessionResult | null>(null);
  const [isToggling, setIsToggling] = React.useState(false);

  React.useEffect(() => {
    setResult(null);
    if (!ciLoop || !currentSessionId) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        try {
          const next = await ciLoop.getSession(currentSessionId);
          if (!cancelled) {
            setResult(next);
          }
        } catch {
          if (!cancelled) {
            setResult((prev) => prev ?? { available: false });
          }
        }
      }
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void tick();
        }, CI_LOOP_POLL_INTERVAL_MS);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [ciLoop, currentSessionId]);

  const session = result?.available ? result.session : null;
  const phaseView = usePhaseView(session?.watch ?? null);

  const handleToggle = React.useCallback(async (checked: boolean) => {
    if (!ciLoop || !currentSessionId) {
      return;
    }
    setIsToggling(true);
    try {
      const next = await ciLoop.setEnabled(currentSessionId, checked);
      setResult({ available: true, session: next });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('gitView.ciLoop.toast.toggleFailed'), { description: message });
    } finally {
      setIsToggling(false);
    }
  }, [ciLoop, currentSessionId, t]);

  if (!ciLoop || !currentSessionId || !session) {
    return null;
  }

  return (
    <section className="border-0 bg-transparent rounded-none">
      <div className="flex items-center justify-between gap-3 pt-3">
        <div className="min-w-0 space-y-1">
          <div className="typography-ui-header font-semibold text-foreground">
            {t('gitView.ciLoop.title')}
          </div>
          <div className="typography-micro text-muted-foreground">
            {t('gitView.ciLoop.description')}
          </div>
        </div>
        <Switch
          checked={session.enabled}
          onCheckedChange={(checked) => {
            void handleToggle(checked);
          }}
          disabled={isToggling}
          aria-label={t('gitView.ciLoop.toggleLabel')}
        />
      </div>

      {session.watch && phaseView ? (
        <div className="mt-2 flex min-w-0 items-center gap-2 typography-micro">
          <span
            className="inline-flex shrink-0 items-center gap-1.5"
            style={{ color: phaseView.colorVar }}
          >
            <Icon
              name={phaseView.iconName}
              className={phaseView.spinning ? 'size-3.5 animate-spin' : 'size-3.5'}
            />
            {phaseView.text}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">
            {session.watch.branch} @ {session.watch.sha.slice(0, 8)}
          </span>
        </div>
      ) : null}
    </section>
  );
};
