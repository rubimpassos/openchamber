import { describe, expect, it, vi } from 'vitest';

import { createSessionRuntime } from './session-runtime.js';
import { restartInterruptedNotification } from '../session-interruption/restart.js';

describe('managed OpenCode restart session recovery', () => {
  it('settles busy sessions and broadcasts one interruption notification that lists every session', () => {
    const events = [];
    const broadcastUiNotification = vi.fn();
    const rebindUpstream = vi.fn();
    const sessionRuntime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: (event) => events.push(event),
    });
    const onOpenCodeRestarted = () => {
      rebindUpstream();
      const { sessionIds } = sessionRuntime.interruptBusySessionsAfterRestart();
      if (sessionIds.length > 0) {
        broadcastUiNotification(restartInterruptedNotification(sessionIds.map((sessionId) => ({ sessionId, directory: '/repo', title: null }))));
      }
    };
    const markBusy = (sessionID) => sessionRuntime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID, status: { type: 'busy' } },
    });

    try {
      markBusy('session-1');
      markBusy('session-2');
      markBusy('session-3');
      events.length = 0;

      onOpenCodeRestarted();

      expect(rebindUpstream).toHaveBeenCalledOnce();
      expect(sessionRuntime.getActiveSessionCount()).toBe(0);
      expect(Object.values(sessionRuntime.getSessionStateSnapshot()).map((state) => state.status))
        .toEqual(['idle', 'idle', 'idle']);
      expect(events.filter((event) => event.type === 'openchamber:session-status')).toHaveLength(3);
      expect(events.filter((event) => event.type === 'session.error')).toHaveLength(3);
      expect(broadcastUiNotification).toHaveBeenCalledOnce();
      expect(broadcastUiNotification).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'opencode-restart-interrupted',
        sessionId: 'session-1',
        sessions: [
          { sessionId: 'session-1', directory: '/repo' },
          { sessionId: 'session-2', directory: '/repo' },
          { sessionId: 'session-3', directory: '/repo' },
        ],
      }));
    } finally {
      sessionRuntime.dispose();
    }
  });
});
