import React from 'react';
import { useI18n } from '@/lib/i18n';

export const useModelPickerLabels = (placeholder?: string) => {
  const { t } = useI18n();
  return React.useMemo(() => ({
    searchPlaceholder: t('settings.agents.modelSelector.searchPlaceholder'),
    list: t('chat.modelControls.modelListAria'),
    noResults: t('settings.agents.modelSelector.state.noModelsFound'),
    favorites: t('settings.agents.modelSelector.section.favorites'),
    recent: t('settings.agents.modelSelector.section.recent'),
    keyboardHint: t('settings.agents.modelSelector.keyboardHints'),
    notSelected: placeholder || t('settings.agents.modelSelector.notSelected'),
    favorite: t('settings.agents.modelSelector.actions.favorite'),
    unfavorite: t('settings.agents.modelSelector.actions.unfavorite'),
    provider: t('chat.modelControls.provider'),
    capabilities: t('chat.modelControls.capabilities'),
    capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
    capabilityReasoning: t('chat.modelControls.capability.reasoning'),
    input: t('chat.modelControls.input'),
    output: t('chat.modelControls.output'),
    costPerMillion: t('chat.modelControls.costPerMillion'),
  }), [placeholder, t]);
};
