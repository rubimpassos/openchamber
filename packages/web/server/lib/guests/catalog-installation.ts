import type { GuestPackage, GuestRecord } from './contracts.js';

type InstallationLocation = {
  readonly path: string | null;
  readonly folders: GuestRecord['folders'];
};

export const withSource = (guest: GuestPackage, source: string, location: InstallationLocation) => ({
  ...guest,
  source,
  path: location.path,
  folders: location.folders,
});

export const copyPublicGuestFolders = (guest: GuestRecord, row: Pick<GuestRecord, 'folders'>) => {
  if (guest.folders?.length) {
    row.folders = [...guest.folders];
  }
};
