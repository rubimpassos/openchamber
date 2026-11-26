import React from 'react';
import type { ServerBrowserState } from '@/lib/browser/serverBrowser/types';

export type RegisterBrowserBackHandler = (handler: (() => boolean) | null) => void;

export const useServerBrowserBackHandler = (
  register: RegisterBrowserBackHandler | undefined,
  action: (() => Promise<ServerBrowserState | null>) | null,
): void => {
  const actionRef = React.useRef(action);
  actionRef.current = action;
  React.useEffect(() => {
    if (!register) return undefined;
    register(() => {
      const back = actionRef.current;
      if (!back) return false;
      void back();
      return true;
    });
    return () => register(null);
  }, [register]);
};
