import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { McpToolPermissionsEditor } from '@/components/sections/shared/McpToolPermissionsEditor';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { fetchBotIdentities } from '@/lib/botsApi';
import type { BotDefinition } from '@/lib/bots/config';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { BotDiscordFields } from './BotDiscordFields';
import { BotIdentitySelect } from './BotIdentityFields';
import { useBotGitHubAccounts } from './useBotGitHubAccounts';
import { useBotResource } from './useBotRequest';

const IDENTITY_CONNECTORS = ['github', 'jira', 'discord'] as const;
const MCP_CONNECTORS = ['mcp', 'correctionMcp'] as const;
type IdentityConnector = (typeof IDENTITY_CONNECTORS)[number];
type McpConnector = (typeof MCP_CONNECTORS)[number];
export type BotConnector = IdentityConnector | McpConnector;

const IDENTITY_COPY = {
  github: { name: 'GitHub', unlocks: 'bots.config.connectors.github.unlocks', without: 'bots.config.connectors.github.without' },
  jira: { name: 'Jira', unlocks: 'bots.config.connectors.jira.unlocks', without: 'bots.config.connectors.jira.without' },
  discord: { name: 'Discord', unlocks: 'bots.config.connectors.discord.unlocks', without: 'bots.config.connectors.discord.without' },
} satisfies Record<IdentityConnector, { readonly name: string; readonly unlocks: I18nKey; readonly without: I18nKey }>;
const MCP_NAMES = {
  mcp: 'bots.config.connectors.investigationMcp', correctionMcp: 'bots.correctionMcp',
} satisfies Record<McpConnector, I18nKey>;

function ConnectorCard({ name, kind, unlocks, without, onRemove, children }: {
  readonly name: string; readonly kind: string; readonly unlocks: string; readonly without: string;
  readonly onRemove: () => void; readonly children: React.ReactNode;
}) {
  const { t } = useI18n();
  return <article className="oc-tile min-w-0 space-y-3 rounded-lg p-3">
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 typography-ui-label text-foreground">
          {name}<span className="typography-meta text-muted-foreground">{kind}</span>
        </h3>
        <p className="typography-meta">{unlocks} <span className="text-muted-foreground">{without}</span></p>
      </div>
      <Button variant="ghost" size="sm" className="shrink-0" aria-label={t('bots.config.connectors.removeNamed', { name })} onClick={onRemove}>{t('bots.config.action.remove')}</Button>
    </div>
    {children}
  </article>;
}

export function BotConnectorsFields({ projectId, bot, added, onAdded, onChange, onManage }: {
  readonly projectId: string; readonly bot: BotDefinition;
  readonly added: readonly BotConnector[]; readonly onAdded: (added: readonly BotConnector[]) => void;
  readonly onChange: (patch: Partial<BotDefinition>) => void; readonly onManage: () => void;
}) {
  const { t } = useI18n();
  const load = React.useCallback(() => fetchBotIdentities(projectId), [projectId]);
  const identities = useBotResource(load);
  const github = useBotGitHubAccounts();
  const configured = (connector: BotConnector) => {
    switch (connector) {
      case 'github': case 'jira': return bot.identity[connector] !== undefined;
      case 'discord': return bot.identity.discord !== undefined || bot.discord.channels.length > 0;
      case 'mcp': case 'correctionMcp': return bot[connector].length > 0;
    }
  };
  const shown = (connector: BotConnector) => configured(connector) || added.includes(connector);
  const remove = (connector: BotConnector) => {
    onAdded(added.filter((entry) => entry !== connector));
    switch (connector) {
      case 'github': onChange({ identity: { ...bot.identity, github: undefined } }); break;
      case 'jira': onChange({ identity: { ...bot.identity, jira: undefined } }); break;
      case 'discord': onChange({ identity: { ...bot.identity, discord: undefined }, discord: { channels: [] } }); break;
      case 'mcp': onChange({ mcp: [] }); break;
      case 'correctionMcp': onChange({ correctionMcp: [] }); break;
    }
  };
  const identityChoices = IDENTITY_CONNECTORS.filter((connector) => !shown(connector));
  const mcpChoices = MCP_CONNECTORS.filter((connector) => !shown(connector));
  const identityKind = t('bots.config.connectors.kind.identity');
  const mcpKind = t('bots.config.connectors.kind.mcp');
  const add = (connector: BotConnector) => { if (!added.includes(connector)) onAdded([...added, connector]); };
  const failed = identities.error || github.error;
  const busy = identities.busy || github.busy;
  const empty = identityChoices.length === IDENTITY_CONNECTORS.length && mcpChoices.length === MCP_CONNECTORS.length;

  return <SettingsSection title={t('bots.config.tab.connectors')} divider={false} contentClassName="space-y-3" headerAction={<div className="flex flex-wrap justify-end gap-2">
    <Button size="sm" variant="ghost" onClick={onManage}>{t('bots.config.connectors.manage')}</Button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={identityChoices.length + mcpChoices.length === 0}><Icon name="add" />{t('bots.config.connectors.add')}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {identityChoices.length ? <DropdownMenuLabel>{identityKind}</DropdownMenuLabel> : null}
        {identityChoices.map((connector) => <DropdownMenuItem key={connector} onSelect={() => add(connector)}>{IDENTITY_COPY[connector].name}</DropdownMenuItem>)}
        {identityChoices.length && mcpChoices.length ? <DropdownMenuSeparator /> : null}
        {mcpChoices.length ? <DropdownMenuLabel>{mcpKind}</DropdownMenuLabel> : null}
        {mcpChoices.map((connector) => <DropdownMenuItem key={connector} onSelect={() => add(connector)}>{t(MCP_NAMES[connector])}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>}>
    <div className="min-h-5 typography-meta" role={failed ? 'alert' : 'status'}>
      {failed ? <span className="text-[var(--status-error-text)]">{t('bots.error')}</span>
        : busy ? <span className="text-muted-foreground">{t('common.loading')}</span>
          : empty ? <span className="text-muted-foreground">{t('bots.config.connectors.empty')}</span> : null}
    </div>
    {IDENTITY_CONNECTORS.filter(shown).map((connector) => <ConnectorCard key={connector} name={IDENTITY_COPY[connector].name} kind={identityKind}
      unlocks={t(IDENTITY_COPY[connector].unlocks)} without={t(IDENTITY_COPY[connector].without)} onRemove={() => remove(connector)}>
      <BotIdentitySelect service={connector} value={bot.identity} onChange={(identity) => { add(connector); onChange({ identity }); }}
        identities={identities.data?.identities ?? []} accounts={github.accounts} />
      {connector === 'discord' ? <BotDiscordFields value={bot.discord} onChange={(discord) => { add(connector); onChange({ discord }); }} /> : null}
    </ConnectorCard>)}
    {MCP_CONNECTORS.filter(shown).map((connector) => <ConnectorCard key={connector} name={t(MCP_NAMES[connector])} kind={mcpKind}
      unlocks={t('bots.config.connectors.mcp.unlocks')} without={t('bots.config.connectors.mcp.without')} onRemove={() => remove(connector)}>
      {connector === 'mcp' ? <p className="typography-meta text-[var(--status-warning-text)]">{t('bots.mcpWarning')}</p> : null}
      <McpToolPermissionsEditor projectId={projectId} value={bot[connector]}
        onChange={(rules) => { add(connector); onChange(connector === 'mcp' ? { mcp: rules } : { correctionMcp: rules }); }} />
    </ConnectorCard>)}
  </SettingsSection>;
}
