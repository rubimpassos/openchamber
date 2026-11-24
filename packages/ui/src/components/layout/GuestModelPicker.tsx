import React from 'react';
import { Menu } from '@base-ui/react/menu';
import type { ModelPickResult } from '@openchamber/sdk';
import { ModelPickerList, type ModelPickerEntry } from '@/components/model-picker/ModelPickerList';
import { useModelPickerLabels } from '@/components/model-picker/useModelPickerLabels';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { GlassRedrawGuard } from '@/components/ui/glass-redraw-guard';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from '@/components/icon/Icon';
import { useModelLists } from '@/hooks/useModelLists';
import { useI18n } from '@/lib/i18n';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useHeightMorphRef } from '@/lib/motion/useSizeMorph';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import type { GuestModelPickerOpening } from '@/hooks/useGuestModelPicker';

export const GuestModelPicker = ({ opening, onResult }: {
  readonly opening: GuestModelPickerOpening;
  readonly onResult: (result: ModelPickResult) => void;
}) => {
  const { request, directory, anchor } = opening;
  const { t } = useI18n();
  const labels = useModelPickerLabels(request.none?.label);
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, directory || undefined));
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const providerOrder = useUIStore((state) => state.providerOrder);
  const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
  const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
  const addRecentModel = useUIStore((state) => state.addRecentModel);
  const { favoriteModelsList, recentModelsList } = useModelLists(directory || undefined);
  const [searchQuery, setSearchQuery] = React.useState('');
  const morphHeight = useHeightMorphRef();
  const mobile = isMobileSurfaceRuntime();
  const close = React.useCallback(() => onResult({ picked: false }), [onResult]);
  const select = (entry: ModelPickerEntry) => {
    addRecentModel(entry.providerID, entry.modelID);
    onResult({ picked: true, model: `${entry.providerID}/${entry.modelID}` });
  };
  const separator = request.value?.indexOf('/') ?? -1;
  const selected = request.value
    ? { providerID: request.value.slice(0, separator), modelID: request.value.slice(separator + 1) }
    : null;
  const recommendedProvider = providers.find((provider) => request.recommended?.startsWith(`${provider.id}/`));
  const recommendedModel = recommendedProvider?.models.find((model) => `${recommendedProvider.id}/${model.id}` === request.recommended
    && !hiddenModels.some((hidden) => hidden.providerID === recommendedProvider.id && hidden.modelID === model.id));

  const picker = <ModelPickerList
    providers={providers}
    providerOrder={providerOrder}
    favoriteModels={favoriteModelsList}
    recentModels={recentModelsList}
    hiddenModels={hiddenModels}
    searchQuery={searchQuery}
    onSearchQueryChange={setSearchQuery}
    labels={labels}
    selectedModel={selected}
    includeNotSelected={Boolean(request.none)}
    onSelectNone={() => onResult({ picked: true, model: null })}
    onSelect={select}
    onEscape={close}
    leadingAction={recommendedProvider && recommendedModel ? {
      label: t('contextPanel.plugin.modelPicker.recommended', { model: getModelDisplayName(recommendedModel) }),
      icon: <Icon name="star" className="size-4" />,
      onSelect: () => select({ providerID: recommendedProvider.id, modelID: recommendedModel.id, model: recommendedModel }),
    } : null}
    isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
    onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
    tooltipsEnabled={!mobile}
    {...(mobile ? { autoFocus: false, maxHeightClassName: 'min-h-0 flex-1',
      providersStartCollapsed: true, showKeyboardHints: false } : {})}
  />;
  if (mobile) return <MobileOverlayPanel open title={t('settings.agents.modelSelector.title')} onClose={close} scrollContent={false}>
    <div data-guest-popover-overlay className="flex min-h-0 flex-1 flex-col">{picker}</div>
  </MobileOverlayPanel>;
  return <DropdownMenu open modal={false} onOpenChange={(open) => { if (!open) close(); }}>
    <Menu.Portal>
      <Menu.Positioner anchor={{ getBoundingClientRect: () => anchor }} align="start" side="bottom" sideOffset={4} className="app-region-no-drag z-50">
        <Menu.Popup ref={morphHeight} data-guest-popover-overlay className={`${dropdownMenuPopupClass} w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col`}>
          {picker}
          <GlassRedrawGuard />
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </DropdownMenu>;
};
