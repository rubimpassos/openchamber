import React from 'react';
import { GUEST_STATUS_SECTION_HEIGHT_DEFAULT, clampStatusSectionHeight, type GuestStatusSummaryItem } from '@openchamber/sdk';

import { Icon } from '@/components/icon/Icon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { guestPackageIconSrc, isGuestIconName, resolveGuestIconName } from '@/lib/guests/icon';
import { useI18n } from '@/lib/i18n';
import type { InstalledGuest } from '@/lib/guests/types';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import type { GuestStatusControlBinding } from '@/lib/guests/status-controls';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusCollapsibleSection } from './WorkStatusPrimitives';
import { StatusHeaderControls } from './StatusHeaderControls';
import { GuestStatusViewBody } from './WorkStatusGuestView';
import { useReportWorkStatusPresence } from './presenceContext';
import { extensionSectionId } from './sections';

const PluginPane = React.lazy(() => import('@/components/layout/PluginPane').then((module) => ({ default: module.PluginPane })));

const rememberedHeights = new Map<string, number>();

const SUMMARY_TONE_COLOR = {
  muted: undefined,
  info: 'var(--status-info)',
  success: 'var(--status-success)',
  warning: 'var(--status-warning)',
  error: 'var(--status-error)',
} satisfies Record<NonNullable<GuestStatusSummaryItem['tone']>, string | undefined>;

/** The guest's header readouts: an icon for what is counted, then the value. Unknown icon names draw text only. */
const StatusSummary: React.FC<{ items: GuestStatusSummaryItem[] }> = ({ items }) => (
  <span data-guest-status-summary className="inline-flex items-center gap-2.5">
    {items.map((item, index) => (
      <span
        // The guest sends a whole list each time; position is its identity.
        key={index}
        title={item.label}
        aria-label={item.label}
        className="inline-flex items-center gap-1"
        style={item.tone ? { color: SUMMARY_TONE_COLOR[item.tone] } : undefined}
      >
        {item.icon && isGuestIconName(item.icon) ? <Icon name={item.icon} className="size-3.5 shrink-0" aria-hidden /> : null}
        <span>{item.text}</span>
      </span>
    ))}
  </span>
);

const sameSummary = (left: GuestStatusSummaryItem[], right: GuestStatusSummaryItem[]): boolean => (
  JSON.stringify(left) === JSON.stringify(right)
);

export const WorkStatusExtensionSection: React.FC<{
  guest: InstalledGuest;
  directory: string | null;
}> = ({ guest, directory }) => {
  const { t } = useI18n();
  const sectionId = extensionSectionId(guest.id);
  const expanded = useUIStore(React.useCallback(
    (state) => state.workStatusExpandedSections[sectionId] ?? (guest.statusDefaultExpanded ?? true),
    [guest.statusDefaultExpanded, sectionId],
  ));
  const visible = !guest.statusRequiresProject || Boolean(directory);
  useReportWorkStatusPresence(sectionId, visible);
  const heightKey = `${guest.id}@${guest.version ?? ''}`;
  const [height, setHeight] = React.useState(() => (
    rememberedHeights.get(heightKey) ?? clampStatusSectionHeight(guest.statusHeight ?? GUEST_STATUS_SECTION_HEIGHT_DEFAULT)
  ));
  const handleResize = React.useCallback((next: number) => {
    const clamped = clampStatusSectionHeight(next);
    rememberedHeights.set(heightKey, clamped);
    setHeight((current) => (current === clamped ? current : clamped));
  }, [heightKey]);
  const iconSrc = guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset);
  const [statusControls, setStatusControls] = React.useState<GuestStatusControlBinding | null>(null);
  const actionLayout = statusControls && statusControls.controls.length >= 3 ? 'below' : 'inline';
  const [summary, setSummary] = React.useState<GuestStatusSummaryItem[]>([]);
  const handleSummary = React.useCallback((items: GuestStatusSummaryItem[]) => {
    setSummary((current) => (sameSummary(current, items) ? current : items));
  }, []);
  const keepAlive = guest.statusKeepAlive === true;

  if (!visible) return null;

  const body = (
    <div
      data-guest-status-frame
      className={expanded ? undefined : 'h-0 overflow-hidden'}
      inert={!expanded || undefined}
      aria-hidden={!expanded || undefined}
    >
      {guest.statusSource ? (
        <div data-guest-status-body={guest.id}>
          <ErrorBoundary fallback={<div className="px-1 text-xs text-muted-foreground">{t('contextPanel.plugin.loadFailed')}</div>}>
            <GuestStatusViewBody
              key={`${guest.id}:${directory ?? ''}`}
              guestId={guest.id}
              source={guest.statusSource}
              directory={directory}
              onStatusControls={setStatusControls}
            />
          </ErrorBoundary>
        </div>
      ) : (
        <div data-guest-status-body={guest.id} className="mx-1 overflow-hidden rounded-md" style={{ height }}>
          <ErrorBoundary fallback={<div className="px-1 text-xs text-muted-foreground">{t('contextPanel.plugin.loadFailed')}</div>}>
            <React.Suspense fallback={null}>
              <PluginPane
                mode={pluginModeFromId(guest.id)}
                surface="status"
                item={null}
                onResize={handleResize}
                statusDirectory={directory}
                onStatusControls={setStatusControls}
                onStatusSummary={handleSummary}
              />
            </React.Suspense>
          </ErrorBoundary>
        </div>
      )}
    </div>
  );

  return (
    <WorkStatusCollapsibleSection
      id={sectionId}
      title={guest.statusTitle ?? guest.name}
      iconNode={<GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={iconSrc} className="size-[13px] shrink-0 text-muted-foreground" />}
      defaultExpanded={guest.statusDefaultExpanded ?? true}
      summary={summary.length > 0 ? <StatusSummary items={summary} /> : undefined}
      actionLayout={actionLayout}
      action={expanded && statusControls ? (
        <StatusHeaderControls
          controls={statusControls.controls}
          layout={actionLayout}
          onActivate={(id, value) => statusControls.dispatch(value === undefined ? { id } : { id, value })}
        />
      ) : undefined}
      collapsedContent={keepAlive ? body : undefined}
    >
      {body}
    </WorkStatusCollapsibleSection>
  );
};
