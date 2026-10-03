import { describe, expect, it, vi } from 'vitest';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { stripOpenChamberPrivateEnv } from '../inherited-env.js';

describe('Hermes V2 boundaries', () => {
  it('resolves an older session by ID, not from the first page of sessions', async () => {
    // Given a paged index that does not contain the authorized session.
    const get = vi.fn(async () => ({ id: 'older', location: { directory: '/repo/worktree' } }));
    const list = vi.fn(async () => ({ data: [], next: 'another-page' }));
    const service = createOpenChamberControlService({
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/api/info',
      getOpenCodeAuthHeaders: () => ({}),
      createClient: () => ({ session: { get, list } }),
    });
    // When scope authorization asks for the persisted owner.
    expect(await service.resolveSessionDirectory('older')).toBe('/repo/worktree');
    // Then one authoritative record lookup suffices, regardless of list size.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ sessionID: 'older' });
    expect(list).not.toHaveBeenCalled();
  });

  it('does not pass integration configuration or destination tokens to OpenCode', () => {
    const env = {
      PATH: '/usr/bin', OPENCHAMBER_AGENT_TOOL_TOKEN: 'synthetic-child-callback',
      OPENCHAMBER_INTEGRATION_POLICY_FILE: '/synthetic/policy.json',
      HERMES_OC_TOKEN_VPS: 'synthetic-vps-token', HERMES_OC_TOKEN_OTHER: 'synthetic-other-token',
    };
    expect(stripOpenChamberPrivateEnv(env)).toEqual({
      PATH: '/usr/bin', OPENCHAMBER_AGENT_TOOL_TOKEN: 'synthetic-child-callback',
    });
  });
});
