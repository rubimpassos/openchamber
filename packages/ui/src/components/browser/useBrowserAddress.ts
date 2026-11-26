import React from 'react';

import { toDisplayUrl } from '@/lib/browser/devTunnel';

type BrowserAddress = {
  readonly owner: string;
  readonly value: string;
  readonly edit: (value: string) => void;
  readonly setFocused: (focused: boolean) => void;
};

type AddressDraft = {
  readonly owner: string;
  readonly value: string;
};

export const useBrowserAddress = ({ directory, tabID, requestedUrl, pageUrl }: {
  readonly directory: string;
  readonly tabID: string;
  readonly requestedUrl: string | null;
  readonly pageUrl: string | undefined;
}): BrowserAddress => {
  const owner = `${directory}\u0000${tabID}`;
  const liveAddress = requestedUrl ?? (pageUrl ? toDisplayUrl(pageUrl) : '');
  const [draft, setDraft] = React.useState<AddressDraft | null>(null);
  const focused = React.useRef(false);

  React.useEffect(() => {
    setDraft((current) => (current && current.owner === owner && focused.current ? current : null));
  }, [liveAddress, owner]);

  const edit = React.useCallback((value: string) => setDraft({ owner, value }), [owner]);
  const setFocused = React.useCallback((next: boolean) => {
    focused.current = next;
  }, []);

  return { owner, value: draft && draft.owner === owner ? draft.value : liveAddress, edit, setFocused };
};
