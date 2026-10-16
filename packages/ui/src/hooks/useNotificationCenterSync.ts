/**
 * Keeps the notification center store current: a read of the server's list
 * per runtime and each time the control stream (re)connects, then its change
 * events. An entry for the session on screen while the window is focused is
 * marked read at once, since the user is already looking at it.
 *
 * VS Code has no OpenChamber server and no control stream, so nothing runs
 * there and the center stays `idle` (hidden).
 */
import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useNotificationCenterStore } from '@/stores/useNotificationCenterStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const isViewing = (sessionId: string): boolean => (
  document.visibilityState === 'visible'
  && document.hasFocus()
  && useSessionUIStore.getState().currentSessionId === sessionId
);

export const useNotificationCenterSync = (): void => {
  React.useEffect(() => {
    if (isVSCodeRuntime()) return;
    const store = useNotificationCenterStore.getState();
    void store.load();
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      const current = useNotificationCenterStore.getState();
      current.resetForRuntime();
      void current.load();
    });
    const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
      const current = useNotificationCenterStore.getState();
      if (event.type === 'event-stream-ready') {
        // Changes made while the stream was down are only in the server's list.
        void current.load();
        return;
      }
      if (event.type !== 'notification-center-changed') return;
      current.applyChange(event.change);
      if (event.change.change !== 'added') return;
      const { sessionId } = event.change.entry;
      if (sessionId && isViewing(sessionId)) current.markSessionRead(sessionId);
    });
    return () => {
      unsubscribeRuntime();
      unsubscribeEvents();
    };
  }, []);
};
