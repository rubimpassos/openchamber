import { afterEach, describe, expect, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '../store';
import type { InstalledGuest } from '../types';
import { planGuestPlanAction, runGuestPlanAction, type GuestPlanActionDeps, type GuestPlanActionRefusal, type GuestPlanActionRequest } from './actions';

const guest: InstalledGuest = {
  id: 'plan-shelf',
  name: 'Plan Shelf',
  icon: 'file-list-2',
  backgroundEntry: 'index.html',
  enabled: true,
  capabilities: { requested: ['plans'], granted: ['plans'] },
  plans: [{
    id: 'shelf',
    label: 'Shelf',
    root: 'plans',
    actions: [
      { id: 'run', kind: 'execute', label: 'Run', run: { type: 'command', name: 'shelf-run', arguments: '{plan.name}' } },
      { id: 'review', kind: 'review', label: 'Review', run: { type: 'prompt', text: '/not-a-command review {plan.path}' }, agent: 'planner' },
    ],
  }],
};

const install = (entry: InstalledGuest) => {
  if (useGuestsStore.getState().runtimeKey !== getRuntimeKey()) useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  useGuestsStore.getState().replaceCatalog([entry], getRuntimeKey());
};

afterEach(() => useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey()));

const request = (actionId: string): GuestPlanActionRequest => ({
  guestId: guest.id, providerId: 'shelf', actionId, directory: '/repo/wt', path: 'plans/auth.md', hash: 'h1',
});

const fakeDeps = (overrides: Partial<GuestPlanActionDeps> = {}) => {
  const calls: string[] = [];
  const deps: GuestPlanActionDeps = {
    readPlanHash: async () => 'h1',
    commandExists: async () => true,
    skillExists: async () => true,
    agentExists: async () => true,
    selection: () => ({ providerID: 'p', modelID: 'm', agentName: undefined, variant: undefined }),
    createSession: async (directory) => { calls.push(`create ${directory}`); return 'ses_1'; },
    send: async (sessionId, directory, invocation) => { calls.push(`send ${sessionId} ${directory} ${JSON.stringify(invocation)}`); },
    open: (sessionId) => { calls.push(`open ${sessionId}`); },
    runtimeKey: () => 'rt',
    ...overrides,
  };
  return { deps, calls };
};

describe('extension plan actions', () => {
  test('runs exactly the confirmed invocation in the plan worktree', async () => {
    install(guest);
    const command = planGuestPlanAction(request('run'));
    expect(command?.invocation).toEqual({ type: 'command', name: 'shelf-run', arguments: 'auth' });
    const prompt = planGuestPlanAction(request('review'));
    // A prompt is sent as written: a leading slash does not make it a command.
    expect(prompt?.invocation).toEqual({ type: 'prompt', text: '/not-a-command review plans/auth.md', agent: 'planner' });
    const { deps, calls } = fakeDeps();
    expect(await runGuestPlanAction(command!, deps)).toEqual({ ok: true, sessionId: 'ses_1' });
    expect(calls).toEqual(['create /repo/wt', 'open ses_1', 'send ses_1 /repo/wt {"type":"command","name":"shelf-run","arguments":"auth"}']);
  });

  test('refuses before creating anything when a check fails, without a fallback', async () => {
    install(guest);
    const confirmed = planGuestPlanAction(request('run'))!;
    const cases: Array<[Partial<GuestPlanActionDeps>, GuestPlanActionRefusal]> = [
      [{ commandExists: async () => false }, 'command-missing'],
      [{ commandExists: async () => { throw new Error('down'); } }, 'lookup-failed'],
      [{ readPlanHash: async () => 'h2' }, 'plan-changed'],
      [{ readPlanHash: async () => null }, 'plan-unreadable'],
      [{ selection: () => null }, 'no-model'],
    ];
    for (const [overrides, reason] of cases) {
      const { deps, calls } = fakeDeps(overrides);
      expect(await runGuestPlanAction(confirmed, deps)).toEqual({ ok: false, stage: 'check', reason });
      expect(calls).toEqual([]);
    }
    const { deps: agentDeps } = fakeDeps({ agentExists: async () => false });
    expect(await runGuestPlanAction(planGuestPlanAction(request('review'))!, agentDeps)).toMatchObject({ reason: 'agent-missing' });
  });

  test('a paused extension or a changed declaration starts nothing', async () => {
    install(guest);
    const confirmed = planGuestPlanAction(request('run'))!;
    install({ ...guest, enabled: false });
    expect(planGuestPlanAction(request('run'))).toBeNull();
    const paused = fakeDeps();
    expect(await runGuestPlanAction(confirmed, paused.deps)).toMatchObject({ ok: false, reason: 'extension-unavailable' });
    install({ ...guest, plans: [{ ...guest.plans![0]!, actions: [{ ...guest.plans![0]!.actions![0]!, run: { type: 'command', name: 'other' } }] }] });
    const changed = fakeDeps();
    expect(await runGuestPlanAction(confirmed, changed.deps)).toMatchObject({ ok: false, reason: 'action-changed' });
    expect([...paused.calls, ...changed.calls]).toEqual([]);
  });

  test('pausing the extension while the session is created sends nothing', async () => {
    install(guest);
    let sends = 0;
    const { deps } = fakeDeps({
      createSession: async () => { install({ ...guest, enabled: false }); return 'ses_1'; },
      send: async () => { sends += 1; },
    });
    expect(await runGuestPlanAction(planGuestPlanAction(request('run'))!, deps)).toMatchObject({ ok: false, stage: 'send', sessionId: 'ses_1' });
    expect(sends).toBe(0);
  });

  test('a failed send keeps the created session and reports it, without retrying', async () => {
    install(guest);
    let sends = 0;
    const { deps } = fakeDeps({ send: async () => { sends += 1; throw new Error('network'); } });
    expect(await runGuestPlanAction(planGuestPlanAction(request('run'))!, deps)).toEqual({ ok: false, stage: 'send', sessionId: 'ses_1', message: 'network' });
    expect(sends).toBe(1);
  });
});
