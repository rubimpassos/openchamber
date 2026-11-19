import { HostRequestError, type GuestModelCatalog } from '@openchamber/sdk';
import { getModelDisplayName } from '@/lib/modelDisplay';
import { listModelVariantIds } from '@/lib/modelVariants';
import { selectCatalogLoadedForDirectory, selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

/** Project the picker's current catalog without exposing provider or model settings. */
export const readGuestModels = (directory?: string): GuestModelCatalog => {
  const config = useConfigStore.getState();
  if (!selectCatalogLoadedForDirectory(config, 'models', directory)) {
    throw new HostRequestError('HOST_UNAVAILABLE', 'The model catalog has not loaded yet.');
  }
  const hidden = new Set(useUIStore.getState().hiddenModels.map(({ providerID, modelID }) => `${providerID}:${modelID}`));
  return selectProvidersForDirectory(config, directory).flatMap((provider) => provider.models
    .filter((model) => !hidden.has(`${provider.id}:${model.id}`))
    .map((model) => ({
      id: `${provider.id}/${model.id}`,
      name: getModelDisplayName(model),
      variants: listModelVariantIds(model.variants),
    })));
};
