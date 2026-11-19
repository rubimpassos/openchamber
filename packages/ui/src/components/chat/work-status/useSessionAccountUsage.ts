import React from 'react';

import {
  ACCOUNT_PROVIDER,
  fetchLimitAccounts,
  fetchSessionAccount,
  type LimitAccountUsage,
} from '@/lib/limit-failover/client';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { subscribeCredentialChanges } from '@/lib/opencode/integration-catalog';

/**
 * The plan usage of the account the session's next request goes out on, as
 * the limit failover swept it. Null when the session's provider has no
 * per-account usage, or the server has not seen the account or its usage.
 * `refreshKey` re-reads it when the usage panel refreshes.
 */
export const useSessionAccountUsage = (
  sessionId: string | null,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  refreshKey: readonly object[],
): { label: string; usage: LimitAccountUsage } | null => {
  const enabled = Boolean(sessionId) && providerId === ACCOUNT_PROVIDER;
  const [state, setState] = React.useState<{ label: string; usage: LimitAccountUsage } | null>(null);
  const [revision, setRevision] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const reload = () => setRevision((value) => value + 1);
    const unsubscribeCredentials = subscribeCredentialChanges(reload);
    const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
      if (event.type === 'limit-failover') reload();
    });
    return () => {
      unsubscribeCredentials();
      unsubscribeEvents();
    };
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled || !sessionId) {
      setState(null);
      return undefined;
    }
    let active = true;
    void Promise.all([
      fetchSessionAccount({ sessionId, providerId: ACCOUNT_PROVIDER, modelId }),
      fetchLimitAccounts(ACCOUNT_PROVIDER),
    ])
      .then(([{ accountId }, accounts]) => {
        if (!active) return;
        const account = accounts.find((candidate) => candidate.id === accountId);
        setState(account?.usage ? { label: account.label, usage: account.usage } : null);
      })
      .catch(() => {
        if (active) setState(null);
      });
    return () => {
      active = false;
    };
  }, [enabled, sessionId, modelId, refreshKey, revision]);

  return enabled ? state : null;
};
