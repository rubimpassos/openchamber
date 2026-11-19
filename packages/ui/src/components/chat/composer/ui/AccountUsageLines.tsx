import React from 'react';

import { useI18n } from '@/lib/i18n';
import { getCurrentIntlLocale } from '@/lib/i18n/intl';
import { modelWindows, windowPercent, type LimitAccount } from '@/lib/limit-failover/client';

const formatReset = (resetAt: number): string => new Intl.DateTimeFormat(getCurrentIntlLocale(), {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}).format(resetAt);

/**
 * One account's swept plan usage and the limits the failover saw run out, as
 * compact lines. Shared by the composer's account picker and the account rows
 * on the provider page.
 */
export const AccountUsageLines: React.FC<{
  account: Pick<LimitAccount, 'usage' | 'exhausted'>;
  /** The picker has room for the nearest exhaustion only. */
  firstExhaustionOnly?: boolean;
}> = ({ account, firstExhaustionOnly = false }) => {
  const { t } = useI18n();
  const windows = (['5h', '7d'] as const)
    .map((window) => ({ window, percent: windowPercent(account.usage, window) }))
    .filter((entry): entry is { window: '5h' | '7d'; percent: number } => entry.percent !== null);
  const models = modelWindows(account.usage);
  const marks = firstExhaustionOnly ? account.exhausted.slice(0, 1) : account.exhausted;
  if (windows.length === 0 && models.length === 0 && marks.length === 0) return null;
  const usage = [
    ...windows.map((entry) => t('chat.sessionAccount.usage', { window: entry.window, used: Math.round(entry.percent) })),
    ...models.map((entry) => t('chat.sessionAccount.usage', { window: entry.model, used: Math.round(entry.usedPercent) })),
  ];
  return (
    <span className="flex flex-col typography-micro text-muted-foreground tabular-nums">
      {usage.length > 0 ? <span>{usage.join(' · ')}</span> : null}
      {marks.map((mark) => (
        <span key={mark.scope} className={mark.scope === '*' ? 'text-destructive' : 'text-[var(--status-warning-text)]'}>
          {mark.scope === '*'
            ? t('chat.sessionAccount.exhaustedAccount', { time: formatReset(mark.resetAt) })
            : t('chat.sessionAccount.exhaustedModel', { model: mark.scope, time: formatReset(mark.resetAt) })}
        </span>
      ))}
    </span>
  );
};
