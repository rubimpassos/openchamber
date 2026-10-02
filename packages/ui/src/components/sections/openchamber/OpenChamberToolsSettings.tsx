import * as React from 'react';

import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { updateDesktopSettings } from '@/lib/persistence';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

/**
 * Which OpenChamber capabilities agents are given.
 *
 * Each entry is one tool the managed OpenCode child is handed, so the choices
 * belong together and not under the CLI's own configuration — the binary path
 * is about which OpenCode runs, these are about what it can do.
 *
 * A toggle only writes the setting: the server keeps OpenChamber's plugin
 * injection in a watched file, so OpenCode picks the change up on its own and
 * the tool list is live without a restart.
 */
export const OpenChamberToolsSettings: React.FC = () => {
  const { t } = useI18n();
  const agentControlToolEnabled = useUIStore((state) => state.agentControlToolEnabled);
  const setAgentControlToolEnabled = useUIStore((state) => state.setAgentControlToolEnabled);
  const agentWebToolEnabled = useUIStore((state) => state.agentWebToolEnabled);
  const setAgentWebToolEnabled = useUIStore((state) => state.setAgentWebToolEnabled);
  const agentMemoryToolEnabled = useUIStore((state) => state.agentMemoryToolEnabled);
  // Absent, not merely off: the feature is finished but unreleased, and a
  // visible switch invites turning on something that was never announced.
  const agentMemoryAvailable = useUIStore((state) => state.agentMemoryFeatureAvailable);
  const setAgentMemoryToolEnabled = useUIStore((state) => state.setAgentMemoryToolEnabled);
  const agentNotifyToolEnabled = useUIStore((state) => state.agentNotifyToolEnabled);
  const setAgentNotifyToolEnabled = useUIStore((state) => state.setAgentNotifyToolEnabled);

  const handleAgentControlToolChange = React.useCallback((enabled: boolean) => {
    setAgentControlToolEnabled(enabled);
    void updateDesktopSettings({ agentControlToolEnabled: enabled });
  }, [setAgentControlToolEnabled]);

  const handleAgentWebToolChange = React.useCallback((enabled: boolean) => {
    setAgentWebToolEnabled(enabled);
    void updateDesktopSettings({ agentWebToolEnabled: enabled });
  }, [setAgentWebToolEnabled]);

  const handleAgentNotifyToolChange = React.useCallback((enabled: boolean) => {
    setAgentNotifyToolEnabled(enabled);
    void updateDesktopSettings({ agentNotifyToolEnabled: enabled });
  }, [setAgentNotifyToolEnabled]);

  // Turning memory off removes the whole feature, not just the tool: the panel
  // tab goes with it and sessions stop being given the index. Showing the user
  // what is stored would be pointless once the agent can no longer manage it.
  const handleAgentMemoryToolChange = React.useCallback((enabled: boolean) => {
    setAgentMemoryToolEnabled(enabled);
    // Re-read after the write lands, not before. The switch flips the client
    // immediately, which makes the panel ask the server straight away — and
    // while the setting is still being written the server truthfully answers
    // "disabled", which used to leave the tab hidden until a restart.
    void updateDesktopSettings({ agentMemoryToolEnabled: enabled })
      .finally(() => {
        if (enabled) {
          void useAgentMemoryStore.getState().refresh();
        }
      });
  }, [setAgentMemoryToolEnabled]);

  return (
    <SettingsSection title={t('settings.openchamber.tools.title')}>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          settingsItem="sessions.agent-control-tool"
          checked={agentControlToolEnabled}
          onChange={handleAgentControlToolChange}
          label={t('settings.openchamber.tools.field.agentControlTool')}
          ariaLabel={t('settings.openchamber.tools.field.agentControlToolAria')}
          info={t('settings.openchamber.tools.field.agentControlToolInfo')}
        />

        <SettingsCheckboxRow
          settingsItem="sessions.agent-web-tool"
          checked={agentWebToolEnabled}
          onChange={handleAgentWebToolChange}
          label={t('settings.openchamber.tools.field.agentWebTool')}
          ariaLabel={t('settings.openchamber.tools.field.agentWebToolAria')}
          info={t('settings.openchamber.tools.field.agentWebToolInfo')}
        />

        <SettingsCheckboxRow
          settingsItem="sessions.agent-notify-tool"
          checked={agentNotifyToolEnabled}
          onChange={handleAgentNotifyToolChange}
          label={t('settings.openchamber.tools.field.agentNotifyTool')}
          ariaLabel={t('settings.openchamber.tools.field.agentNotifyToolAria')}
          info={t('settings.openchamber.tools.field.agentNotifyToolInfo')}
        />

        {agentMemoryAvailable ? (
        <SettingsCheckboxRow
          settingsItem="sessions.agent-memory-tool"
          checked={agentMemoryToolEnabled}
          onChange={handleAgentMemoryToolChange}
          label={t('settings.openchamber.tools.field.agentMemoryTool')}
          ariaLabel={t('settings.openchamber.tools.field.agentMemoryToolAria')}
          info={t('settings.openchamber.tools.field.agentMemoryToolInfo')}
        />
        ) : null}
      </div>
    </SettingsSection>
  );
};
