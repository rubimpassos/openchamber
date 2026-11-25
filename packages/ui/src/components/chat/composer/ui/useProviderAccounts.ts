import React from 'react';
import { findIntegrationForProvider, getCredentialConnections } from '@/components/sections/providers/providerAuth';
import { fetchLimitAccounts, type LimitAccount } from '@/lib/limit-failover/client';
import { loadIntegrationCatalog, peekIntegrationCatalog, subscribeCredentialChanges } from '@/lib/opencode/integration-catalog';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

type Account = { id: string; label: string; limits: LimitAccount | null };

const signInAccounts = (integrations: Parameters<typeof findIntegrationForProvider>[0], providerId: string) => (
  getCredentialConnections(findIntegrationForProvider(integrations, providerId)).filter((credential) => credential.method === 'oauth')
);
const loadSignInAccounts = async (providerId: string) => signInAccounts((await loadIntegrationCatalog()).integrations, providerId);

export const useProviderAccounts = (
  providerId: string,
  enabled: boolean,
  sessionId: string | null,
  loadAccounts: (providerId: string) => Promise<{ id: string; label: string }[]> = loadSignInAccounts,
): Account[] => {
  const [credentials, setCredentials] = React.useState<{ id: string; label: string }[]>(() => (
    signInAccounts(peekIntegrationCatalog()?.integrations ?? [], providerId)
  ));
  const [limits, setLimits] = React.useState<LimitAccount[]>([]);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return undefined;
    const reload = () => setRevision((value) => value + 1);
    const unsubscribeCredentials = subscribeCredentialChanges(reload);
    const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
      if (event.type === 'limit-failover') reload();
    });
    return () => { unsubscribeCredentials(); unsubscribeEvents(); };
  }, [enabled]);
  React.useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    void loadAccounts(providerId).then((next) => { if (active) setCredentials(next); }).catch(() => undefined);
    void fetchLimitAccounts(providerId).then((next) => { if (active) setLimits(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [enabled, providerId, sessionId, revision, loadAccounts]);
  return React.useMemo(() => credentials.map((credential) => ({
    id: credential.id, label: credential.label,
    limits: limits.find((entry) => entry.id === credential.id) ?? null,
  })), [credentials, limits]);
};
