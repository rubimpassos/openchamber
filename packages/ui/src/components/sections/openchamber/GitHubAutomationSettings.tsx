import React from 'react';
import { SettingsControlGroup, SettingsRadioGroup, SettingsRadioOption, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { PrFixLoopConfigFields } from '@/components/session/PrFixLoopConfigFields';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_PR_FIX_LOOP_CONFIG, fixLoopConfigSchema } from '@/lib/prFixLoop';
import { useUIStore } from '@/stores/useUIStore';

export function GitHubAutomationSettings() {
  const { t } = useI18n();
  const defaults = useUIStore((state) => state.prFixLoopDefaults);
  const conflictMode = useUIStore((state) => state.prStackConflictMode);
  if (isVSCodeRuntime()) return null;
  const parsed = fixLoopConfigSchema.partial().safeParse(defaults);
  const config = parsed.success ? { ...DEFAULT_PR_FIX_LOOP_CONFIG, ...parsed.data } : DEFAULT_PR_FIX_LOOP_CONFIG;
  return <>
    <SettingsSection title={t('prFixLoop.settings.defaults')} info={t('prFixLoop.settings.defaults.info')} settingsItem="integrations.pr-fix-loop">
      <PrFixLoopConfigFields config={config} settings onChange={(patch) => {
        const store = useUIStore.getState();
        store.setPrFixLoopDefaults({ ...store.prFixLoopDefaults, ...patch });
      }} />
    </SettingsSection>
    <SettingsControlGroup title={t('prFixLoop.settings.conflict')} info={t('prFixLoop.settings.conflict.info')} settingsItem="integrations.pr-stack-conflict">
      <SettingsRadioGroup aria-label={t('prFixLoop.settings.conflict')}>
        <SettingsRadioOption selected={conflictMode === 'pause'} onSelect={() => useUIStore.getState().setPrStackConflictMode('pause')}
          label={t('prFixLoop.settings.conflict.pause')} />
        <SettingsRadioOption selected={conflictMode === 'agent'} onSelect={() => useUIStore.getState().setPrStackConflictMode('agent')}
          label={t('prFixLoop.settings.conflict.agent')} />
      </SettingsRadioGroup>
    </SettingsControlGroup>
  </>;
}
