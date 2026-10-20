import { useEffect, useState } from 'react';
import type { I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { mcpCapabilitiesSchema, type McpScope } from '@/stores/mcpConfigResponse';

export const MCP_SCOPE_LABEL_KEYS = {
  user: 'settings.mcp.grid.scope.user',
  project: 'settings.mcp.grid.scope.project',
  local: 'settings.mcp.grid.scope.local',
} as const satisfies Record<McpScope, I18nKey>;

export const MCP_SCOPE_INFO_KEYS = {
  user: 'settings.mcp.page.scope.userInfo',
  project: 'settings.mcp.page.scope.projectInfo',
  local: 'settings.mcp.page.scope.localInfo',
} as const satisfies Record<McpScope, I18nKey>;

export const getLocalMcpUnavailableReason = (
  projectLocal: boolean | null,
  directory: string | null,
): I18nKey | null => {
  if (!directory?.trim()) return 'settings.mcp.page.scope.localRequiresProject';
  if (projectLocal === null) return 'settings.mcp.page.scope.localUnknown';
  if (!projectLocal) return 'settings.mcp.page.scope.localUnsupported';
  return null;
};

/** Settings remounts on runtime changes; no capability survives that visit. */
export const useMcpProjectLocalCapability = (): boolean | null => {
  const [projectLocal, setProjectLocal] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await runtimeFetch('/api/config/mcp-capabilities', { signal: controller.signal });
        if (!response.ok) return;
        const capabilities = mcpCapabilitiesSchema.parse(await response.json());
        if (!controller.signal.aborted) setProjectLocal(capabilities.projectLocal);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        // A failed read leaves support unknown and creation unavailable.
        if (!controller.signal.aborted) setProjectLocal(null);
      }
    };
    void load();
    return () => controller.abort();
  }, []);
  return projectLocal;
};
