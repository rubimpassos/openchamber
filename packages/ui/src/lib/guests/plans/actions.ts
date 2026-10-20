import {
  resolveGuestPlanAction,
  type GuestPlanActionContribution,
  type GuestPlanActionInvocation,
} from '@openchamber/sdk';

import { captureDefaultSendSelection } from '@/lib/defaultSendSelection';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { guestMay } from '../capabilities';
import { useGuestsStore } from '../store';
import { readGuestPlanFile } from './api';
import { findGuestPlanProvider } from './catalog';

/**
 * A provider action, from the click to the new session. The user confirms
 * one exact invocation (what runs, in which worktree, for which revision of
 * the plan). Before anything is created, every part of it is checked again:
 * the extension is still active and allowed `plans`, the action is still
 * declared with the same invocation, the plan file is still the revision the
 * user looked at, and the worktree knows the command, skill and agent. A
 * failed check creates nothing, and nothing else is run in its place.
 */

export type GuestPlanActionRequest = {
  guestId: string;
  providerId: string;
  actionId: string;
  directory: string;
  path: string;
  /** Hash of the plan text the user saw when confirming. */
  hash: string;
};

export type GuestPlanActionPlan = {
  request: GuestPlanActionRequest;
  action: GuestPlanActionContribution;
  invocation: GuestPlanActionInvocation;
};

export type GuestPlanActionRefusal =
  | 'extension-unavailable'
  | 'action-changed'
  | 'plan-changed'
  | 'plan-unreadable'
  | 'command-missing'
  | 'skill-missing'
  | 'agent-missing'
  | 'lookup-failed'
  | 'no-model'
  | 'runtime-changed';

export type GuestPlanActionOutcome =
  | { ok: true; sessionId: string }
  /** Nothing was created. */
  | { ok: false; stage: 'check'; reason: GuestPlanActionRefusal }
  | { ok: false; stage: 'create' }
  /** The session exists; the send failed or its outcome is unknown, so it is not retried. */
  | { ok: false; stage: 'send'; sessionId: string; message: string };

/** The invocation to confirm, or null when the extension does not declare this action now. */
export const planGuestPlanAction = (request: GuestPlanActionRequest): GuestPlanActionPlan | null => {
  const guest = useGuestsStore.getState().guests.find((entry) => entry.id === request.guestId) ?? null;
  if (!guestMay(guest, 'plans')) return null;
  const action = findGuestPlanProvider(guest, request.providerId)?.actions?.find((entry) => entry.id === request.actionId);
  if (!action) return null;
  return { request, action, invocation: resolveGuestPlanAction(action, request.path) };
};

const sameInvocation = (left: GuestPlanActionInvocation, right: GuestPlanActionInvocation): boolean => (
  JSON.stringify(left) === JSON.stringify(right)
);

export type GuestPlanActionDeps = {
  readPlanHash: (request: GuestPlanActionRequest) => Promise<string | null>;
  commandExists: (name: string, directory: string) => Promise<boolean>;
  skillExists: (name: string, directory: string) => Promise<boolean>;
  agentExists: (name: string, directory: string) => Promise<boolean>;
  selection: () => ReturnType<typeof captureDefaultSendSelection>;
  createSession: (directory: string, selection: NonNullable<ReturnType<typeof captureDefaultSendSelection>>, agent: string | undefined) => Promise<string | null>;
  send: (sessionId: string, directory: string, invocation: GuestPlanActionInvocation, selection: NonNullable<ReturnType<typeof captureDefaultSendSelection>>, runtimeKey: string) => Promise<void>;
  open: (sessionId: string, directory: string) => void;
  runtimeKey: () => string;
};

const checkInvocation = async (
  invocation: GuestPlanActionInvocation,
  directory: string,
  deps: GuestPlanActionDeps,
): Promise<GuestPlanActionRefusal | null> => {
  try {
    if (invocation.type === 'command' && !(await deps.commandExists(invocation.name, directory))) return 'command-missing';
    if (invocation.type === 'skill' && !(await deps.skillExists(invocation.name, directory))) return 'skill-missing';
    if (invocation.agent && !(await deps.agentExists(invocation.agent, directory))) return 'agent-missing';
  } catch {
    // An unanswered lookup is not "it exists": refuse rather than guess.
    return 'lookup-failed';
  }
  return null;
};

export const runGuestPlanAction = async (
  confirmed: GuestPlanActionPlan,
  deps: GuestPlanActionDeps = defaultGuestPlanActionDeps,
): Promise<GuestPlanActionOutcome> => {
  const runtimeKey = deps.runtimeKey();
  const { request } = confirmed;
  const current = planGuestPlanAction(request);
  if (!current) return { ok: false, stage: 'check', reason: 'extension-unavailable' };
  if (!sameInvocation(current.invocation, confirmed.invocation)) return { ok: false, stage: 'check', reason: 'action-changed' };

  const hash = await deps.readPlanHash(request).catch(() => null);
  if (hash === null) return { ok: false, stage: 'check', reason: 'plan-unreadable' };
  if (hash !== request.hash) return { ok: false, stage: 'check', reason: 'plan-changed' };

  const refusal = await checkInvocation(confirmed.invocation, request.directory, deps);
  if (refusal) return { ok: false, stage: 'check', reason: refusal };
  const selection = deps.selection();
  if (!selection) return { ok: false, stage: 'check', reason: 'no-model' };
  if (deps.runtimeKey() !== runtimeKey || !planGuestPlanAction(request)) {
    return { ok: false, stage: 'check', reason: deps.runtimeKey() !== runtimeKey ? 'runtime-changed' : 'extension-unavailable' };
  }

  const sessionId = await deps.createSession(request.directory, selection, confirmed.invocation.agent).catch(() => null);
  if (!sessionId) return { ok: false, stage: 'create' };
  deps.open(sessionId, request.directory);
  // The extension may have been paused, its approval withdrawn or its action
  // changed while the session was created: the empty session stays, and
  // nothing is sent into it.
  const stillAllowed = planGuestPlanAction(request);
  if (deps.runtimeKey() !== runtimeKey || !stillAllowed || !sameInvocation(stillAllowed.invocation, confirmed.invocation)) {
    return { ok: false, stage: 'send', sessionId, message: 'The extension or its action changed before sending.' };
  }
  try {
    await deps.send(sessionId, request.directory, confirmed.invocation, selection, runtimeKey);
  } catch (error) {
    return { ok: false, stage: 'send', sessionId, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, sessionId };
};

const defaultGuestPlanActionDeps: GuestPlanActionDeps = {
  readPlanHash: async (request) => {
    const read = await readGuestPlanFile(request.guestId, request.providerId, request.directory, request.path);
    return read.ok ? read.result.hash : null;
  },
  commandExists: async (name, directory) => (await opencodeClient.listCommands(directory)).some((command) => command.name === name),
  skillExists: async (name, directory) => (await opencodeClient.listSkills(directory)).some((skill) => skill.name === name || skill.id === name),
  agentExists: async (name, directory) => (await opencodeClient.listAgents(directory)).some((agent) => agent.name === name),
  selection: captureDefaultSendSelection,
  createSession: async (directory, selection, agent) => {
    const session = await useSessionUIStore.getState().createSession(undefined, directory, undefined, {
      model: { providerID: selection.providerID, id: selection.modelID, variant: selection.variant || undefined },
      agent: agent ?? selection.agentName ?? undefined,
    });
    if (!session?.id) return null;
    useSessionUIStore.getState().initializeNewOpenChamberSession(session.id, useConfigStore.getState().agents ?? []);
    return session.id;
  },
  send: async (sessionId, directory, invocation, selection, runtimeKey) => {
    const agent = invocation.agent ?? selection.agentName ?? undefined;
    const model = { providerID: selection.providerID, id: selection.modelID, variant: selection.variant || undefined };
    if (invocation.type === 'command') {
      await opencodeClient.sendCommand({ runtimeKey, id: sessionId, model, agent, command: invocation.name, arguments: invocation.arguments, directory });
      return;
    }
    await opencodeClient.sendMessage({
      runtimeKey,
      id: sessionId,
      model,
      agent,
      providerID: selection.providerID,
      text: invocation.text,
      directory,
      ...(invocation.type === 'skill'
        ? { skills: { names: [invocation.name], instructionFor: () => null }, skillsRequired: true }
        : {}),
    });
  },
  open: (sessionId, directory) => useSessionUIStore.getState().setCurrentSession(sessionId, directory),
  runtimeKey: getRuntimeKey,
};
