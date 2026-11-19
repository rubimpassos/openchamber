import { create } from 'zustand';

import type { SessionAccountMode } from '@/lib/limit-failover/client';

// The account a session draft will run on, chosen in the composer before the
// session exists. Keyed by draft id, so a choice never reaches another draft.
// sendMessage in session-ui-store takes it when the draft becomes a session
// and stores the pin before the first prompt goes out.
interface DraftSessionAccount {
  draftId: number;
  providerId: string;
  mode: Exclude<SessionAccountMode, 'global'>;
  credentialId: string;
}

interface DraftSessionAccountStore {
  choice: DraftSessionAccount | null;
  setChoice: (choice: DraftSessionAccount | null) => void;
  /** Read-and-clear the draft's choice in one step at send time. */
  take: (draftId: number) => DraftSessionAccount | null;
}

export const useDraftSessionAccountStore = create<DraftSessionAccountStore>((set, get) => ({
  choice: null,
  setChoice: (choice) => set({ choice }),
  take: (draftId) => {
    const { choice } = get();
    if (choice?.draftId !== draftId) return null;
    set({ choice: null });
    return choice;
  },
}));
