import { useId } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { MCP_SCOPES } from '@/stores/mcpConfigResponse';
import { getLocalMcpUnavailableReason, MCP_SCOPE_INFO_KEYS, MCP_SCOPE_LABEL_KEYS, type McpScopeChoice } from './mcpScope';
import type { protectedScopeAvailability } from './protectedMcp';

type McpScopeSelectProps = {
  readonly value: McpScopeChoice;
  readonly onChange: (value: McpScopeChoice) => void;
  readonly projectLocal: boolean | null;
  readonly directory: string | null;
  readonly protectedAvailability?: ReturnType<typeof protectedScopeAvailability>;
  readonly sharedAdministration?: boolean;
};

/** Scope is chosen only while creating a server. */
export function McpScopeSelect({ value, onChange, projectLocal, directory, protectedAvailability, sharedAdministration }: McpScopeSelectProps) {
  const { t } = useI18n();
  const unavailableReason = getLocalMcpUnavailableReason(projectLocal, directory);
  const unavailableReasonId = useId();
  const protectedReasonId = useId();
  return (
    <>
      <Select value={value} onValueChange={(candidate) => {
        if (candidate === 'protected') {
          if (protectedAvailability?.visible && !protectedAvailability.disabledReason) onChange(candidate);
          return;
        }
        const scope = MCP_SCOPES.find((option) => option === candidate);
        if (!scope || (scope === 'local' && unavailableReason)) return;
        onChange(scope);
      }}>
        <SelectTrigger className="min-w-0 max-w-full" aria-label={t('settings.mcp.page.scope.label')}>
          <Icon name={value === 'protected' ? 'lock' : value === 'user' ? 'user-3' : 'folder'} className="size-3.5 shrink-0" />
          <span className="truncate">{t(MCP_SCOPE_LABEL_KEYS[value])}</span>
        </SelectTrigger>
        <SelectContent align="end">
          {MCP_SCOPES.map((scope) => (
            <SelectItem key={scope} value={scope} disabled={scope === 'local' && unavailableReason !== null}
              aria-describedby={scope === 'local' && unavailableReason ? unavailableReasonId : undefined}>
              <Icon name={scope === 'user' ? 'user-3' : 'folder'} className="size-3.5" />
              <span>{t(MCP_SCOPE_LABEL_KEYS[scope])}</span>
            </SelectItem>
          ))}
          {unavailableReason ? <p id={unavailableReasonId} className="max-w-64 px-2 py-1.5 typography-meta text-muted-foreground">{t(unavailableReason)}</p> : null}
          {protectedAvailability?.visible ? <>
            <SelectItem value="protected" disabled={protectedAvailability.disabledReason !== null}
              aria-describedby={protectedAvailability.disabledReason ? protectedReasonId : undefined}>
              <Icon name="lock" className="size-3.5" />
              <span>{t(MCP_SCOPE_LABEL_KEYS.protected)}</span>
            </SelectItem>
            {protectedAvailability.disabledReason ? <p id={protectedReasonId} className="max-w-64 px-2 py-1.5 typography-meta text-muted-foreground">{t(protectedAvailability.disabledReason)}</p> : null}
          </> : null}
        </SelectContent>
      </Select>
      <SettingsInfoHint>
        {MCP_SCOPES.map((scope) => <p key={scope}>{t(MCP_SCOPE_LABEL_KEYS[scope])}. {t(MCP_SCOPE_INFO_KEYS[scope])}</p>)}
        {protectedAvailability?.visible ? <p>{t(MCP_SCOPE_LABEL_KEYS.protected)}. {t(MCP_SCOPE_INFO_KEYS.protected)}</p> : null}
        {protectedAvailability?.visible && sharedAdministration ? <p>{t('settings.mcp.page.scope.sharedAdministration')}</p> : null}
      </SettingsInfoHint>
    </>
  );
}
