
import { useI18n } from '@/lib/i18n';
import { spaceIdOfDirectory } from './space-route';
import { useSpacesStore } from './spaces-store';
import { spacePlaceName } from './space-places';

export const useSpaceMarkLabel = (directory: string | null | undefined): string | null => {
  const { t } = useI18n();
  const spaceId = spaceIdOfDirectory(directory);
  const entry = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId) : undefined));
  if (spaceId === null) return null;
  if (!entry) return t('contextPanel.browser.spaceAddress');
  const place = spacePlaceName(t, entry);
  return `${entry.name} · ${place}`;
};
