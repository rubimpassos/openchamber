import React from 'react';

import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/lib/i18n';
import { refreshGuestPlanCatalog, type GuestPlanEntry } from '@/lib/guests/plans/catalog';
import type { GuestPlanProviderView } from '@/lib/guests/plans/useGuestPlanProviders';
import { extensionPlanEntryId, visibleExtensionPlans, type ExtensionPlanSelection } from '@/lib/guests/plans/selection';
import type { GuestPlanStatusTone } from '@openchamber/sdk';
import { cn } from '@/lib/utils';

const ExtensionPlanProgress: React.FC<{ plan: GuestPlanEntry }> = ({ plan }) => {
  const { t } = useI18n();
  if (!plan.progress || plan.progress.total === 0) return null;
  if (plan.progress.done >= plan.progress.total) {
    return (
      <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-success)] bg-[var(--status-success)]/15">
        {t('rightSidebar.contextNotesTodo.plans.progress.done')}
      </span>
    );
  }
  return (
    <span className="shrink-0 typography-micro tabular-nums text-muted-foreground" title={t('extensionPlans.progress.title', plan.progress)}>
      {`${plan.progress.done}/${plan.progress.total}`}
    </span>
  );
};

const STATUS_TONE_CLASS = {
  neutral: 'text-muted-foreground bg-[var(--surface-subtle)]',
  info: 'text-[var(--status-info)] bg-[var(--status-info)]/15',
  success: 'text-[var(--status-success)] bg-[var(--status-success)]/15',
  warning: 'text-[var(--status-warning)] bg-[var(--status-warning)]/15',
  error: 'text-[var(--status-error)] bg-[var(--status-error)]/15',
} satisfies Record<GuestPlanStatusTone, string>;

export const ExtensionPlanStatus: React.FC<{ plan: GuestPlanEntry }> = ({ plan }) => (
  plan.status ? (
    <span className={cn('shrink-0 typography-micro px-1 rounded leading-none pb-px', STATUS_TONE_CLASS[plan.status.tone ?? 'neutral'])}>
      {plan.status.label}
    </span>
  ) : null
);

const ProviderNotice: React.FC<{ tone?: 'muted' | 'error'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <p className={cn('px-3 py-2 typography-meta', tone === 'error' ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>{children}</p>
);

const ProviderGroup: React.FC<{
  view: GuestPlanProviderView;
  directory: string;
  query: string;
  selectedEntryId: string | null;
  onOpen: (selection: ExtensionPlanSelection) => void;
}> = ({ view, directory, query, selectedEntryId, onOpen }) => {
  const { t } = useI18n();
  const extension = view.guest.name;
  const catalog = view.catalog;
  const plans = visibleExtensionPlans(view, query);
  const searching = query.trim().length > 0;
  // A search with no match in this provider hides the whole group.
  if (searching && plans.length === 0) return null;

  const body = (() => {
    if (view.state === 'paused') return <ProviderNotice>{t('extensionPlans.section.paused', { extension })}</ProviderNotice>;
    if (view.state === 'needs-approval') return <ProviderNotice>{t('extensionPlans.section.needsApproval', { extension })}</ProviderNotice>;
    if (!catalog || catalog.status === 'loading') {
      return (
        <p className="flex items-center gap-2 px-3 py-2 typography-meta text-muted-foreground">
          <Spinner className="size-3.5" />
          {t('extensionPlans.section.loading')}
        </p>
      );
    }
    if (catalog.status === 'error') {
      return (
        <div className="flex items-center gap-2 px-3 py-2">
          <p className="min-w-0 flex-1 typography-meta text-[var(--status-error)]">{t('extensionPlans.section.error', { message: catalog.message })}</p>
          <button
            type="button"
            className="shrink-0 typography-meta text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            onClick={() => void refreshGuestPlanCatalog({ guestId: view.guest.id, providerId: view.provider.id, directory })}
          >
            {t('extensionPlans.section.retry')}
          </button>
        </div>
      );
    }
    if (catalog.plans.length === 0) return <ProviderNotice>{t('extensionPlans.section.empty', { root: view.provider.root })}</ProviderNotice>;
    return (
      <>
        <ul className="divide-y divide-border/50">
          {plans.map((plan) => {
            const selection: ExtensionPlanSelection = { guestId: view.guest.id, providerId: view.provider.id, directory, path: plan.path };
            const entryId = extensionPlanEntryId(selection);
            return (
              <li
                key={plan.path}
                data-knowledge-entry-id={entryId}
                aria-current={entryId === selectedEntryId ? 'true' : undefined}
                className={cn('flex items-center gap-1 py-1 pe-1.5 ps-1', entryId === selectedEntryId && 'bg-interactive-selection/40')}
              >
                <button
                  type="button"
                  onClick={() => onOpen(selection)}
                  title={plan.path}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-start text-foreground/85 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 truncate typography-ui-label" dir="auto">{plan.title ?? plan.name}</span>
                  <ExtensionPlanStatus plan={plan} />
                  <ExtensionPlanProgress plan={plan} />
                </button>
              </li>
            );
          })}
        </ul>
        {catalog.truncated ? <ProviderNotice>{t('extensionPlans.section.truncated', { count: catalog.plans.length })}</ProviderNotice> : null}
        {catalog.description.state === 'loading' ? (
          <p className="flex items-center gap-2 px-3 py-2 typography-micro text-muted-foreground">
            <Spinner className="size-3" />
            {t('extensionPlans.section.describing', { extension })}
          </p>
        ) : null}
        {catalog.description.state === 'failed' ? (
          <ProviderNotice>
            {catalog.description.message
              ? t('extensionPlans.section.describeFailedWithMessage', { extension, message: catalog.description.message })
              : t('extensionPlans.section.describeFailed', { extension })}
          </ProviderNotice>
        ) : null}
      </>
    );
  })();

  return (
    <section aria-label={view.provider.label} className="space-y-1">
      <h3 className="flex min-w-0 items-baseline gap-1.5 px-1 typography-meta">
        <span className="truncate font-medium text-foreground">{view.provider.label}</span>
        <span className="truncate text-muted-foreground">{extension}</span>
      </h3>
      <div className="rounded-lg bg-background/40 border border-border/60">{body}</div>
    </section>
  );
};

/**
 * Plans other tools keep as files in the worktree, shown through the
 * extensions that know them (`contributes.plans`). They are not Project
 * knowledge plans: they open in their own view, edit their own file, and
 * run only the extension's declared actions.
 */
export const ExtensionPlansSection: React.FC<{
  providers: GuestPlanProviderView[];
  directory: string;
  query: string;
  selectedEntryId: string | null;
  onOpen: (selection: ExtensionPlanSelection) => void;
}> = ({ providers, directory, query, selectedEntryId, onOpen }) => {
  if (providers.length === 0) return null;
  return (
    <div className="space-y-3">
      {providers.map((view) => (
        <ProviderGroup
          key={`${view.guest.id}:${view.provider.id}`}
          view={view}
          directory={directory}
          query={query}
          selectedEntryId={selectedEntryId}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
};
