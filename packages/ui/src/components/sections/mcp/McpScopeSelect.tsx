import { useId } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { MCP_SCOPES, type McpScope } from '@/stores/mcpConfigResponse';
import { getLocalMcpUnavailableReason, MCP_SCOPE_INFO_KEYS, MCP_SCOPE_LABEL_KEYS } from './mcpScope';

type McpScopeSelectProps = {
  readonly value: McpScope;
  readonly onChange: (value: McpScope) => void;
  readonly projectLocal: boolean | null;
  readonly directory: string | null;
};

/** Scope is chosen only while creating a server. */
export function McpScopeSelect({ value, onChange, projectLocal, directory }: McpScopeSelectProps) {
  const { t } = useI18n();
  const unavailableReason = getLocalMcpUnavailableReason(projectLocal, directory);
  const unavailableReasonId = useId();
  return (
    <>
      <Select value={value} onValueChange={(candidate) => {
        const scope = MCP_SCOPES.find((option) => option === candidate);
        if (!scope || (scope === 'local' && unavailableReason)) return;
        onChange(scope);
      }}>
        <SelectTrigger className="min-w-0 max-w-full" aria-label={t('settings.mcp.page.scope.label')}>
          <Icon name={value === 'user' ? 'user-3' : 'folder'} className="size-3.5 shrink-0" />
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
        </SelectContent>
      </Select>
      <SettingsInfoHint>
        {MCP_SCOPES.map((scope) => <p key={scope}>{t(MCP_SCOPE_LABEL_KEYS[scope])}. {t(MCP_SCOPE_INFO_KEYS[scope])}</p>)}
      </SettingsInfoHint>
    </>
  );
}
