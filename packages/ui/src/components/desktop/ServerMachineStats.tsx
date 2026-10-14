import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { ServerMachineStatsState } from '@/hooks/useServerMachineStats';
import { useI18n } from '@/lib/i18n';
import {
  machineLevel,
  worstMachinePressure,
  type MachineLevel,
  type MachineResource,
  type ServerMachineSample,
} from '@/lib/serverMachineStats';
import { cn } from '@/lib/utils';

type ReadyState = Extract<ServerMachineStatsState, { kind: 'ready' }>;

const levelFillClass = {
  ok: 'bg-[var(--status-success)]',
  warning: 'bg-[var(--status-warning)]',
  critical: 'bg-[var(--status-error)]',
} satisfies Record<MachineLevel, string>;

const levelStrokeVar = {
  ok: 'var(--status-success)',
  warning: 'var(--status-warning)',
  critical: 'var(--status-error)',
} satisfies Record<MachineLevel, string>;

const levelTextClass = {
  ok: 'text-[var(--status-success)]',
  warning: 'text-[var(--status-warning)]',
  critical: 'text-[var(--status-error)]',
} satisfies Record<MachineLevel, string>;

const GIB = 1024 ** 3;

const useFormatBytes = (): ((bytes: number) => string) => {
  const { locale } = useI18n();
  return React.useMemo(() => {
    const gigabytes = new Intl.NumberFormat(locale, { style: 'unit', unit: 'gigabyte', maximumFractionDigits: 1 });
    const megabytes = new Intl.NumberFormat(locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 0 });
    return (bytes: number) => (bytes >= GIB ? gigabytes.format(bytes / GIB) : megabytes.format(bytes / 1024 ** 2));
  }, [locale]);
};

const secondsSince = (from: number, to: number): number => Math.max(0, Math.round((to - from) / 1000));

const isStale = (state: ReadyState): boolean => state.failingSince !== null;

function UsageBar({ percent, level, className }: { percent: number | null; level: MachineLevel; className?: string }) {
  return (
    <div className={cn('h-1 overflow-hidden rounded-full bg-[var(--interactive-border)]', className)}>
      {percent !== null ? (
        <div className={cn('h-full rounded-full', levelFillClass[level])} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      ) : null}
    </div>
  );
}

function Sparkline({ values, level }: { values: number[]; level: MachineLevel }) {
  if (values.length < 2) return <div className="mt-1 h-[18px]" />;
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${17 - (Math.min(100, Math.max(0, value)) / 100) * 16}`)
    .join(' ');
  return (
    <svg className="mt-1 block h-[18px] w-full" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={levelStrokeVar[level]} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function MetricCard({ label, percent, level, detail, history }: {
  label: string;
  percent: number | null;
  level: MachineLevel;
  detail: string;
  history: number[] | null;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-muted)] px-2.5 py-2">
      <div className="flex items-center justify-between typography-micro text-muted-foreground">
        <span>{label}</span>
        {level !== 'ok' ? <span className={cn('h-1.5 w-1.5 rounded-full', levelFillClass[level])} aria-hidden="true" /> : null}
      </div>
      <div className={cn('typography-ui-label font-semibold', level === 'ok' ? 'text-foreground' : levelTextClass[level])}>
        {percent === null ? '—' : `${Math.round(percent)}%`}
      </div>
      <UsageBar percent={percent} level={level} className="mt-1" />
      {history ? <Sparkline values={history} level={level} /> : null}
      <div className="mt-0.5 truncate typography-micro text-muted-foreground" title={detail}>{detail}</div>
    </div>
  );
}

function useUptimeLabel(): (seconds: number) => string {
  const { t } = useI18n();
  return (seconds) => {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return t('header.services.machine.uptime.days', { days, hours });
    if (hours > 0) return t('header.services.machine.uptime.hours', { hours, minutes });
    return t('header.services.machine.uptime.minutes', { minutes });
  };
}

function MachineAlert({ state }: { state: ReadyState }) {
  const { t } = useI18n();
  const formatBytes = useFormatBytes();
  const { sample } = state;

  if (state.failingSince !== null) {
    return (
      <AlertBox level="critical">
        {t('header.services.machine.alert.stale', { seconds: secondsSince(state.lastSuccessAt, state.checkedAt) })}
      </AlertBox>
    );
  }

  const pressure = worstMachinePressure(sample);
  if (!pressure) return null;
  const percent = Math.round(pressure.percent);
  const message = pressure.resource === 'disk' && sample.disk
    ? t('header.services.machine.alert.disk', { percent, free: formatBytes(sample.disk.availableBytes), path: sample.disk.path })
    : pressure.resource === 'memory'
      ? t('header.services.machine.alert.memory', { percent })
      : t('header.services.machine.alert.cpu', { percent });
  return <AlertBox level={pressure.level}>{message}</AlertBox>;
}

function AlertBox({ level, children }: { level: Exclude<MachineLevel, 'ok'>; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 typography-micro text-foreground',
        level === 'critical'
          ? 'border-[var(--status-error-border)] bg-[var(--status-error-background)]'
          : 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)]',
      )}
    >
      <Icon name="error-warning" className={cn('mt-px h-3.5 w-3.5 flex-shrink-0', levelTextClass[level])} />
      <span>{children}</span>
    </div>
  );
}

function FactsGrid({ sample }: { sample: ServerMachineSample }) {
  const { t } = useI18n();
  const formatBytes = useFormatBytes();
  const uptimeLabel = useUptimeLabel();
  const cores = sample.cpu.cores === 1
    ? t('header.services.machine.coresOne')
    : t('header.services.machine.coresOther', { count: sample.cpu.cores });
  const processCpu = sample.process.cpuPercent === null ? null : Math.round(sample.process.cpuPercent);
  const processUsage = processCpu === null
    ? formatBytes(sample.process.rssBytes)
    : t('header.services.machine.processUsage', { memory: formatBytes(sample.process.rssBytes), cpu: processCpu });
  // Long values on the left, short ones on the right: the right value column
  // sizes to its content and the left one takes what is left.
  const facts: Array<{ label: string; value: React.ReactNode; title?: string; mono?: boolean }> = [
    { label: t('header.services.machine.fact.host'), value: sample.hostname, title: sample.hostname, mono: true },
    { label: t('header.services.machine.fact.uptime'), value: uptimeLabel(sample.uptimeSec) },
    { label: t('header.services.machine.fact.system'), value: `${sample.osName} · ${sample.arch}`, title: `${sample.osName} · ${sample.arch}` },
    { label: t('header.services.machine.fact.cpu'), value: cores, title: sample.cpu.model ?? undefined },
    { label: t('header.services.machine.fact.process'), value: processUsage, title: processUsage },
    {
      label: 'OpenCode',
      value: sample.openCodeRunning
        ? <span className="text-[var(--status-success)]">{t('header.services.machine.opencode.running')}</span>
        : <span className="text-[var(--status-error)]">{t('header.services.machine.opencode.stopped')}</span>,
    },
    { label: 'OpenChamber', value: sample.openchamberVersion },
  ];
  return (
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-2.5 gap-y-0.5 typography-micro">
      {facts.map((fact) => (
        <React.Fragment key={fact.label}>
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className={cn('m-0 truncate text-foreground', fact.mono && 'font-mono')} title={fact.title}>{fact.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** "Machine" block of the instance menu: resources of the connected server. */
export function ServerMachinePanel({ state, refreshSeconds }: { state: ServerMachineStatsState; refreshSeconds: number }) {
  const { t } = useI18n();
  const formatBytes = useFormatBytes();

  let meta: string | null = null;
  let body: React.ReactNode;
  if (state.kind === 'loading') {
    body = <div className="mt-1 typography-micro text-muted-foreground">{t('header.services.machine.loading')}</div>;
  } else if (state.kind === 'unsupported') {
    body = <div className="mt-1 typography-micro text-muted-foreground">{t('header.services.machine.unsupported')}</div>;
  } else if (state.kind === 'unavailable') {
    body = <div className="mt-1 typography-micro text-[var(--status-error-text)]">{t('header.services.machine.unavailable')}</div>;
  } else {
    const { sample } = state;
    const stale = isStale(state);
    meta = stale
      ? t('header.services.machine.lastReading', { seconds: secondsSince(state.lastSuccessAt, state.checkedAt) })
      : t('header.services.machine.refreshEvery', { seconds: refreshSeconds });
    const load = sample.cpu.loadAverage;
    body = (
      <>
        <MachineAlert state={state} />
        <div className={cn(stale && 'opacity-55')}>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <MetricCard
              label={t('header.services.machine.cpu')}
              percent={sample.cpu.usagePercent}
              level={machineLevel('cpu', sample.cpu.usagePercent)}
              detail={load ? t('header.services.machine.load', { load: load.map((value) => value.toFixed(1)).join(' ') }) : ''}
              history={state.cpuHistory}
            />
            <MetricCard
              label={t('header.services.machine.memory')}
              percent={sample.memory.usedPercent}
              level={machineLevel('memory', sample.memory.usedPercent)}
              detail={t('header.services.machine.memoryOf', {
                used: formatBytes(sample.memory.totalBytes - sample.memory.availableBytes),
                total: formatBytes(sample.memory.totalBytes),
              })}
              history={state.memoryHistory}
            />
            <MetricCard
              label={t('header.services.machine.disk')}
              percent={sample.disk?.usedPercent ?? null}
              level={machineLevel('disk', sample.disk?.usedPercent ?? null)}
              detail={sample.disk ? t('header.services.machine.diskFree', { free: formatBytes(sample.disk.availableBytes) }) : ''}
              history={null}
            />
          </div>
          <FactsGrid sample={sample} />
        </div>
      </>
    );
  }

  return (
    <div className="border-b border-[var(--interactive-border)] px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="typography-ui-label font-medium text-foreground">{t('header.services.machine.title')}</div>
        {meta ? <div className="typography-micro text-muted-foreground">{meta}</div> : null}
      </div>
      {body}
    </div>
  );
}

type MachineStatusSummary = { level: MachineLevel; alert: boolean; text: string | null };

const useMachineStatusSummary = (state: ServerMachineStatsState): MachineStatusSummary | null => {
  const { t } = useI18n();
  if (state.kind !== 'ready') return null;
  if (isStale(state)) {
    return { level: 'critical', alert: true, text: t('header.services.machine.chip.offline') };
  }
  const pressure = worstMachinePressure(state.sample);
  if (pressure) {
    const percent = Math.round(pressure.percent);
    const text = pressure.resource === 'disk'
      ? t('header.services.machine.chip.disk', { percent })
      : pressure.resource === 'memory'
        ? t('header.services.machine.chip.memory', { percent })
        : t('header.services.machine.chip.cpu', { percent });
    return { level: pressure.level, alert: true, text };
  }
  const text = state.latencyMs === null
    ? null
    : t('header.services.machine.chip.ping', { ms: Math.max(0, Math.round(state.latencyMs)) });
  return { level: 'ok', alert: false, text };
};

/**
 * Status beside the instance name on the instance button. The dot is always
 * there once a reading arrived; words only appear when something needs
 * attention (resource under pressure, server not answering), because the
 * button is narrow and the healthy case should stay quiet.
 */
export function ServerMachineChip({ state }: { state: ServerMachineStatsState }) {
  const summary = useMachineStatusSummary(state);
  if (!summary) return null;
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1 typography-micro">
      <span className={cn('h-1.5 w-1.5 rounded-full', levelFillClass[summary.level])} aria-hidden="true" />
      {summary.alert && summary.text ? <span className={levelTextClass[summary.level]}>{summary.text}</span> : null}
    </span>
  );
}

/** The same status as one line of text, for the instance button tooltip. */
export function ServerMachineStatusLine({ state }: { state: ServerMachineStatsState }) {
  const summary = useMachineStatusSummary(state);
  if (!summary?.text) return null;
  return <p className="text-muted-foreground">{summary.text}</p>;
}

const MINI_RESOURCES: Array<{ resource: MachineResource; labelKey: 'header.services.machine.mini.cpu' | 'header.services.machine.mini.memory' | 'header.services.machine.mini.disk' }> = [
  { resource: 'cpu', labelKey: 'header.services.machine.mini.cpu' },
  { resource: 'memory', labelKey: 'header.services.machine.mini.memory' },
  { resource: 'disk', labelKey: 'header.services.machine.mini.disk' },
];

const samplePercent = (sample: ServerMachineSample, resource: MachineResource): number | null => {
  if (resource === 'cpu') return sample.cpu.usagePercent;
  if (resource === 'memory') return sample.memory.usedPercent;
  return sample.disk?.usedPercent ?? null;
};

/** One-line CPU / RAM / disk readout for another instance in the host list. */
export function ServerMachineMiniBars({ state }: { state: ServerMachineStatsState }) {
  const { t } = useI18n();
  if (state.kind !== 'ready') return null;
  return (
    <div className={cn('flex items-center gap-2.5 typography-micro text-muted-foreground', isStale(state) && 'opacity-55')}>
      {MINI_RESOURCES.map(({ resource, labelKey }) => {
        const percent = samplePercent(state.sample, resource);
        if (percent === null) return null;
        return (
          <span key={resource} className="inline-flex items-center gap-1 tabular-nums">
            {t(labelKey)}
            <UsageBar percent={percent} level={machineLevel(resource, percent)} className="w-10 shrink-0 bg-foreground/10" />
            {Math.round(percent)}%
          </span>
        );
      })}
    </div>
  );
}
