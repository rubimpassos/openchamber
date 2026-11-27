import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { BotDefinition } from '@/lib/bots/config';
import type { BotIdentity } from '@/lib/bots/management';
import { useI18n } from '@/lib/i18n';
import type { useBotGitHubAccounts } from './useBotGitHubAccounts';

type Identity = BotDefinition['identity'];
const SERVICE_NAMES = { github: 'GitHub', jira: 'Jira', discord: 'Discord' } as const;

export function BotIdentitySelect({ service, value, onChange, identities, accounts }: {
  readonly service: keyof typeof SERVICE_NAMES; readonly value: Identity; readonly onChange: (identity: Identity) => void;
  readonly identities: readonly BotIdentity[]; readonly accounts: ReturnType<typeof useBotGitHubAccounts>['accounts'];
}) {
  const { t } = useI18n();
  const github = value.github;
  const selected = service !== 'github' ? value[service]?.identityId ?? ''
    : github?.kind === 'account' ? `account:${github.accountId}` : github ? `app:${github.identityId}` : '';
  const options = [{ value: '', label: t('bots.none') }, ...(service === 'github' ? [
    ...accounts.map((account) => ({ value: `account:${account.credentialId}`, label: `${account.user.username} · ${account.source}` })),
    ...identities.filter((entry) => entry.kind === 'github-app').map((entry) => ({ value: `app:${entry.id}`, label: entry.label })),
  ] : identities.filter((entry) => entry.kind.startsWith(`${service}-`)).map((entry) => ({ value: entry.id, label: entry.label })))];
  if (selected && !options.some((entry) => entry.value === selected)) options.push({ value: selected, label: `${t('common.unavailable')} · ${selected}` });
  const choose = (next: string) => {
    if (service !== 'github') return onChange({ ...value, [service]: next ? { identityId: next } : undefined });
    const account = accounts.find((entry) => next === `account:${entry.credentialId}`);
    const app = identities.find((entry) => entry.kind === 'github-app' && next === `app:${entry.id}`);
    onChange({ ...value, github: account ? { kind: 'account', accountId: account.credentialId } : app ? { kind: 'app', identityId: app.id } : undefined });
  };
  return <SettingsFieldRow label={t('bots.config.connectors.identity')}>
    <Select value={selected} onValueChange={choose}>
      <SelectTrigger className="max-w-full" aria-label={t('bots.config.connectors.identityFor', { service: SERVICE_NAMES[service] })}>
        <SelectValue>{() => options.find((option) => option.value === selected)?.label ?? selected}</SelectValue>
      </SelectTrigger>
      <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
  </SettingsFieldRow>;
}
