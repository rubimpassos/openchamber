/**
 * Opens the OpenChamber update dialog from outside the sidebar that owns it
 * (the notification center). The sidebar registers its opener while mounted;
 * without one, nothing opens and the caller falls back.
 */
type UpdateDialogOpener = () => void;

let opener: UpdateDialogOpener | null = null;

export const setUpdateDialogOpener = (next: UpdateDialogOpener): void => {
  opener = next;
};

/** Clears the opener only when it is still this one: another mounted sidebar may have replaced it. */
export const clearUpdateDialogOpener = (current: UpdateDialogOpener): void => {
  if (opener === current) opener = null;
};

/** True when a mounted sidebar opened the dialog. */
export const openUpdateDialog = (): boolean => {
  if (!opener) return false;
  opener();
  return true;
};
