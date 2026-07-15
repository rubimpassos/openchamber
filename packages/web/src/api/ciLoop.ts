import type { CiLoopAPI, CiLoopSessionResult, CiLoopSessionState } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebCiLoopAPI = (): CiLoopAPI => ({
  async getSession(sessionId: string): Promise<CiLoopSessionResult> {
    const response = await runtimeFetch(
      `/api/ci-loop/session/${encodeURIComponent(sessionId)}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
    const payload = await jsonOrNull<CiLoopSessionResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load CI loop session');
    }
    return payload;
  },

  async setEnabled(sessionId: string, enabled: boolean): Promise<CiLoopSessionState> {
    const response = await runtimeFetch(
      `/api/ci-loop/session/${encodeURIComponent(sessionId)}/enabled`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    );
    const payload = await jsonOrNull<{ available?: boolean; session?: CiLoopSessionState; error?: string }>(response);
    if (!response.ok || !payload?.session) {
      throw new Error(payload?.error || response.statusText || 'Failed to toggle CI loop');
    }
    return payload.session;
  },
});
