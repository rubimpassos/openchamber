import React from 'react';

import { isGuestActive } from './capabilities.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

/** The name of the active extension that declares `driver` as its goal driver, else `null`. */
export const goalDriverName = (guests: readonly InstalledGuest[], driver: string | null | undefined): string | null => {
  if (!driver) return null;
  return guests.find((guest) => isGuestActive(guest) && guest.goal?.driver === driver)?.name ?? null;
};

/**
 * Who runs a session goal: an extension's plugin (`goal.driver` names one
 * that is enabled) or `null` for OpenChamber's own loop. A goal whose driver
 * extension is gone or paused is run by OpenChamber again.
 */
export const useGoalDriverName = (driver: string | null | undefined): string | null => {
  const guests = useGuestsStore((state) => state.guests);
  return React.useMemo(() => goalDriverName(guests, driver), [guests, driver]);
};
