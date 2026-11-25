import React from 'react';

export const useBrowserAddressSelection = (address: string, owner: string, focused: boolean) => {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const editedFor = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    if (!focused || editedFor.current === owner) return;
    editedFor.current = null;
    inputRef.current?.select();
  }, [address, owner, focused]);

  return {
    inputRef,
    edit: () => { editedFor.current = owner; },
    focus: () => { editedFor.current = null; },
  };
};
