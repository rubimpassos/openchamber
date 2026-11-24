import React from 'react';
import {
  fetchLimitAccounts,
  fetchPreferredAccount,
  setPreferredAccount,
  type LimitAccount,
} from '@/lib/limit-failover/client';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { subscribeCredentialChanges } from '@/lib/opencode/integration-catalog';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';

/**
 * What the provider does when its active account hits its usage limit, the
 * provider-wide counterpart of a session's account choice:
 *
 * - automatic: the next account becomes active for every session following
 *   the global settings (`accountSwitchProviders`).
 * - preferred: the same, and the preferred account comes back once its limit
 *   lifts (`accountSwitchProviders` plus the server's preferred account).
 * - fixed: the active account stays; a limit ends the turn unless a fallback
 *   model is set.
 */
export type ProviderAccountMode = 'automatic' | 'preferred' | 'fixed';

export interface ProviderAccountModeState {
  /** Null until both stored halves were read. */
  mode: ProviderAccountMode | null;
  preferredId: string | null;
  /** `credentialId` names the preferred account for `preferred`; ignored otherwise. */
  setMode: (mode: ProviderAccountMode, credentialId: string | null) => Promise<void>;
}

const withProvider = (list: string[], providerId: string, included: boolean) => (included
  ? Array.from(new Set([...list, providerId]))
  : list.filter((id) => id !== providerId));

export const useProviderAccountMode = (providerId: string, enabled: boolean): ProviderAccountModeState => {
  const [switching, setSwitching] = React.useState<boolean | null>(null);
  const [preferredId, setPreferredId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSwitching(null);
    setPreferredId(null);
    if (!enabled) return undefined;
    let cancelled = false;
    void Promise.all([
      loadDesktopSettings().then((settings) => (settings?.accountSwitchProviders ?? []).includes(providerId)),
      fetchPreferredAccount(providerId).catch(() => null),
    ]).then(([nextSwitching, nextPreferred]) => {
      if (cancelled) return;
      setSwitching(nextSwitching);
      setPreferredId(nextPreferred);
    }).catch(() => {
      if (!cancelled) setSwitching(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, providerId]);

  const setMode = React.useCallback(async (mode: ProviderAccountMode, credentialId: string | null) => {
    const previous = { switching, preferredId };
    const nextSwitching = mode !== 'fixed';
    const nextPreferred = mode === 'preferred' ? credentialId : null;
    setSwitching(nextSwitching);
    setPreferredId(nextPreferred);
    try {
      // The list is shared by every provider page and every window, so the
      // write starts from the stored list, not the one read when this page opened.
      const stored = (await loadDesktopSettings())?.accountSwitchProviders ?? [];
      const result = await updateDesktopSettings({ accountSwitchProviders: withProvider(stored, providerId, nextSwitching) });
      if (!result.ok) throw new Error('Settings were not saved');
      await setPreferredAccount(providerId, nextPreferred);
    } catch {
      setSwitching(previous.switching);
      setPreferredId(previous.preferredId);
    }
  }, [preferredId, providerId, switching]);

  const mode: ProviderAccountMode | null = switching === null
    ? null
    : !switching ? 'fixed' : preferredId ? 'preferred' : 'automatic';
  return { mode, preferredId, setMode };
};

/** Each stored account's swept usage and live limit marks, by credential id. */
export const useAccountLimits = (providerId: string, enabled: boolean): ReadonlyMap<string, LimitAccount> => {
  const [read, setRead] = React.useState<{ providerId: string; accounts: LimitAccount[] } | null>(null);
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
    if (!enabled) return undefined;
    let active = true;
    void fetchLimitAccounts(providerId)
      .then((next) => {
        if (active) setRead({ providerId, accounts: next });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled, providerId, revision]);

  const accounts = enabled && read?.providerId === providerId ? read.accounts : null;
  return React.useMemo(() => new Map((accounts ?? []).map((account) => [account.id, account])), [accounts]);
};

