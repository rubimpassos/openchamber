import React from 'react';

import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { findIntegrationForProvider, getCredentialConnections } from '@/components/sections/providers/providerAuth';
import { useI18n } from '@/lib/i18n';
import {
  ACCOUNT_PROVIDER,
  fetchLimitAccounts,
  fetchSessionAccount,
  setSessionAccount,
  type LimitAccount,
  type SessionAccountMode,
} from '@/lib/limit-failover/client';
import { loadIntegrationCatalog, peekIntegrationCatalog, subscribeCredentialChanges } from '@/lib/opencode/integration-catalog';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDraftSessionAccountStore } from '@/stores/useDraftSessionAccountStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { AccountUsageLines } from './AccountUsageLines';

type Account = { id: string; label: string; limits: LimitAccount | null };


/** The provider's stored accounts from OpenCode, with the usage the failover swept for them. */
// A session account swaps the request's sign-in token, so only sign-ins count.
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
    return () => {
      unsubscribeCredentials();
      unsubscribeEvents();
    };
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    void loadAccounts(providerId)
      .then((next) => {
        if (active) setCredentials(next);
      })
      .catch(() => undefined);
    // Usage only decorates the list: an unreachable sweep leaves the accounts listed.
    void fetchLimitAccounts(providerId)
      .then((next) => {
        if (active) setLimits(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled, providerId, sessionId, revision, loadAccounts]);

  return React.useMemo(() => credentials.map((credential) => ({
    id: credential.id,
    label: credential.label,
    limits: limits.find((entry) => entry.id === credential.id) ?? null,
  })), [credentials, limits]);
};

/**
 * The account a session runs on, and whether a limit may move it. Shown for a
 * provider with several stored accounts, beside the model picker, in a session
 * and in a new session's draft (the choice is stored when the draft is sent).
 */
export const SessionAccountControl: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useI18n();
  const providerId = useConfigStore((state) => state.currentProviderId);
  const modelId = useConfigStore((state) => state.currentModelId);
  const draftId = useSessionUIStore((state) => (!sessionId && state.newSessionDraft.open ? state.newSessionDraft.draftId : null));
  const draftChoice = useDraftSessionAccountStore((state) => (draftId !== null && state.choice?.draftId === draftId ? state.choice : null));
  const setDraftChoice = useDraftSessionAccountStore((state) => state.setChoice);
  const enabled = providerId === ACCOUNT_PROVIDER && (sessionId !== null || draftId !== null);
  const accounts = useProviderAccounts(ACCOUNT_PROVIDER, enabled, sessionId);

  const [sessionPin, setSessionPin] = React.useState<{ mode: SessionAccountMode; credentialId: string | null; accountId: string | null } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [revision, setRevision] = React.useState(0);

  React.useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    return subscribeOpenchamberEvents((event) => {
      if (event.type === 'limit-failover' && event.failover.sessionId === sessionId) setRevision((value) => value + 1);
    });
  }, [enabled, sessionId]);

  React.useEffect(() => {
    setSessionPin(null);
    if (!enabled || !sessionId) return undefined;
    let active = true;
    void fetchSessionAccount({ sessionId, providerId: ACCOUNT_PROVIDER, modelId })
      .then(({ pin, accountId }) => {
        if (active) setSessionPin({ mode: pin?.mode ?? 'global', credentialId: pin?.credentialID ?? null, accountId });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled, sessionId, modelId, revision]);

  if (!enabled || accounts.length < 2) return null;

  const current: { mode: SessionAccountMode; credentialId: string | null; accountId: string | null } = sessionId
    ? sessionPin ?? { mode: 'global', credentialId: null, accountId: null }
    : { mode: draftChoice?.mode ?? 'global', credentialId: draftChoice?.credentialId ?? null, accountId: draftChoice?.credentialId ?? null };
  const mode = current.mode;
  const labelOf = (id: string | null) => accounts.find((account) => account.id === id)?.label ?? null;
  const triggerLabel = mode === 'global'
    ? labelOf(current.accountId) ?? t('chat.sessionAccount.mode.global')
    : labelOf(current.credentialId) ?? t('chat.sessionAccount.mode.preferred');

  const save = async (next: { mode: SessionAccountMode; credentialId?: string }) => {
    if (!sessionId) {
      if (draftId === null) return;
      setDraftChoice(next.mode === 'global' || !next.credentialId
        ? null
        : { draftId, providerId: ACCOUNT_PROVIDER, mode: next.mode, credentialId: next.credentialId });
      return;
    }
    setSaving(true);
    try {
      const saved = await setSessionAccount({ sessionId, providerId: ACCOUNT_PROVIDER, mode: next.mode, credentialId: next.credentialId });
      setSessionPin({ mode: saved?.mode ?? 'global', credentialId: saved?.credentialID ?? null, accountId: saved?.credentialID ?? null });
      setRevision((value) => value + 1);
    } catch {
      toast.error(t('chat.sessionAccount.error'));
    } finally {
      setSaving(false);
    }
  };

  const chooseMode = (value: string) => {
    if (value === 'global') {
      void save({ mode: 'global' });
      return;
    }
    const credentialId = current.credentialId ?? current.accountId ?? accounts[0]?.id;
    if (!credentialId) return;
    void save({ mode: value === 'fixed' ? 'fixed' : 'preferred', credentialId });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={saving}
          aria-label={t('chat.sessionAccount.button')}
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 typography-ui-label text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
        >
          <Icon name={mode === 'fixed' ? 'lock' : 'user'} className="size-3.5 shrink-0" />
          <span className="max-w-24 truncate">{triggerLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t('chat.sessionAccount.button')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={chooseMode}>
          <DropdownMenuRadioItem value="global" className="flex-col items-start">
            <span>{t('chat.sessionAccount.mode.global')}</span>
            <span className="typography-meta text-muted-foreground">{t('chat.sessionAccount.mode.global.hint')}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="preferred" className="flex-col items-start">
            <span>{t('chat.sessionAccount.mode.preferred')}</span>
            <span className="typography-meta text-muted-foreground">{t('chat.sessionAccount.mode.preferred.hint')}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="fixed" className="flex-col items-start">
            <span>{t('chat.sessionAccount.mode.fixed')}</span>
            <span className="typography-meta text-muted-foreground">{t('chat.sessionAccount.mode.fixed.hint')}</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {mode !== 'global' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={current.credentialId ?? ''}
              onValueChange={(credentialId) => void save({ mode, credentialId })}
            >
              {accounts.map((account) => (
                <DropdownMenuRadioItem key={account.id} value={account.id} className="flex-col items-start">
                  <span className="truncate">{account.label}</span>
                  {account.limits ? <AccountUsageLines account={account.limits} firstExhaustionOnly /> : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
