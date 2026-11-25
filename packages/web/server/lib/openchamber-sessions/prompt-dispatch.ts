import { randomUUID } from 'node:crypto';
import type { SessionPromptInput, SessionSwitchModelInput } from '@opencode/client';
import { asNonEmptyString } from '../shared/guards.js';
import { expandSnippets } from '../snippets/snippets.js';
import { AUTO_MODEL_REF, isAutoModel } from '../routing/defaults.js';
import { parseScheduledCommandPrompt } from '../scheduled-tasks/runtime.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import { hasMessage } from './contracts.js';
import type { SessionClient } from './opencode-client-contract.js';
import type { SessionMetadata } from './session-metadata-store.js';
import type { SessionDispatchAdmission } from './dispatch-admission.js';
import type { SessionServiceDependencies } from './routes.js';

export interface ModelSelection { providerID: string; modelID: string }
export interface Selection {
  model: ModelSelection | null;
  agent: string | null | undefined;
  variant: string | null | undefined;
}
export interface SessionSelectionInput {
  readonly client: SessionClient;
  readonly sessionID?: string;
  readonly directory: string;
  readonly projectId: string | undefined;
  readonly requestedModel: ModelSelection | null;
  readonly requestedAgent: string | null | undefined;
  readonly requestedVariant: string | null | undefined;
  readonly reuseSessionSelection?: boolean;
}
export type GoalInput = { ok: true; enabled: boolean; tokenBudget: number | null } | { ok: false; error: string };
interface DispatchInput extends SessionSelectionInput {
  readonly operationId?: string | undefined;
  readonly sessionID: string;
  readonly baseUrl: string;
  readonly authHeaders: ReturnType<SessionServiceDependencies['getOpenCodeAuthHeaders']>;
  readonly prompt: string;
  readonly goalInput: Extract<GoalInput, { ok: true }>;
  readonly clearResponseStyle?: boolean;
  readonly promptedBySessionId?: string | null;
}
export interface DispatchResult extends Selection {
  model: ModelSelection;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
  promptError?: string;
}
type DispatchSelection = ModelSelection & { agent?: string; variant?: string };
type DispatchOwners = Pick<SessionServiceDependencies, 'resolveAutoSelection' | 'sessionKnowledgeRuntime'> & {
  readonly select: (input: SessionSelectionInput) => Promise<Selection & { model: ModelSelection }>;
  readonly getAdmission: () => SessionDispatchAdmission | undefined;
  readonly createGoal: typeof createSessionGoal;
  readonly writeMetadata: (sessionID: string, patch: SessionMetadata, directory: string) => Promise<void>;
};
const isGoalError = (value: unknown): value is { goalConfigured?: unknown } => !!value && typeof value === 'object';
const readPromptOrigin = async (client: SessionClient, sessionID: string): Promise<{ sessionID: string; title?: string }> => {
  try {
    const title = asNonEmptyString((await client.session.get({ sessionID }))?.title);
    return title ? { sessionID, title } : { sessionID };
  } catch {
    return { sessionID };
  }
};

export function createPromptDispatch({ select, getAdmission, resolveAutoSelection, createGoal, sessionKnowledgeRuntime, writeMetadata }: DispatchOwners) {
  return async ({
    client, baseUrl, authHeaders, sessionID, directory, projectId, prompt, goalInput,
    requestedModel, requestedAgent, requestedVariant, reuseSessionSelection = false,
    clearResponseStyle = true, promptedBySessionId = null, operationId = randomUUID(),
  }: DispatchInput): Promise<DispatchResult> => {
    let { model, agent, variant } = await select({
      client, sessionID, directory, projectId, requestedModel, requestedAgent, requestedVariant, reuseSessionSelection,
    });
    const expandedPrompt = expandSnippets(prompt, directory);
    if (isAutoModel(model)) {
      if (!resolveAutoSelection) throw new OpenChamberControlError('Auto routing is not available on this server. Choose a model.', 400);
      const routed = await resolveAutoSelection({
        sessionId: sessionID, directory, model: AUTO_MODEL_REF, agent: agent ?? null, requestText: expandedPrompt,
      });
      if (routed === null) throw new TypeError("Cannot read properties of null (reading 'model')");
      model = { providerID: routed.model.providerID, modelID: routed.model.id };
      variant = routed.model.variant ?? undefined;
      agent = routed.agent || agent;
    }
    const selection: DispatchSelection = { ...model };
    if (agent) selection.agent = agent;
    if (variant) selection.variant = variant;
    await getAdmission()?.({ sessionId: sessionID, directory, operationId, text: prompt, payload: { prompt, goalInput }, selection });
    const parsedCommand = parseScheduledCommandPrompt(prompt);
    let resolvedCommand = null;
    if (parsedCommand) {
      try {
        const response = await client.command.list();
        const commands = Array.isArray(response?.data) ? response.data : [];
        if (commands.some((candidate) => candidate?.name === parsedCommand.command)) resolvedCommand = parsedCommand;
      } catch {
        void 0;
      }
    }
    if (goalInput.enabled) {
      await createGoal({
        baseUrl, authHeaders, sessionID, directory, objective: expandedPrompt, tokenBudget: goalInput.tokenBudget,
        providerID: model.providerID, modelID: model.modelID,
        onWarning: (message: string, cause: unknown) => console.warn(`[OpenChamberSessions] ${message}:`, (hasMessage(cause) ? cause.message : undefined) || cause),
        persistSessionGoal: async (goalSessionID: string, goalDirectory: string, goal: Awaited<ReturnType<typeof createSessionGoal>>) => {
          await writeMetadata(goalSessionID, { openchamber: { goal } }, goalDirectory);
        },
      });
    }
    const markGoalPartial = (cause: unknown) => {
      if (goalInput.enabled && isGoalError(cause)) cause.goalConfigured = true;
      return cause;
    };
    try {
      if (model) {
        let selected: SessionSwitchModelInput['model'] = { id: model.modelID, providerID: model.providerID };
        if (variant) selected = { ...selected, variant };
        await client.session.switchModel({ sessionID, model: selected });
      }
      if (agent) await client.session.switchAgent({ sessionID, agent });
    } catch (error) {
      throw markGoalPartial(error);
    }
    if (sessionKnowledgeRuntime) {
      try {
        const session = await client.session.get({ sessionID });
        const sessionDirectory = asNonEmptyString(session?.location?.directory);
        if (sessionDirectory) {
          if (clearResponseStyle) await sessionKnowledgeRuntime.sync(sessionID, sessionDirectory, '');
          else await sessionKnowledgeRuntime.sync(sessionID, sessionDirectory);
        }
      } catch (error) {
        console.warn('[OpenChamberSessions] Failed to read session directory for knowledge sync:', (hasMessage(error) ? error.message : undefined) || error);
      }
    }
    if (resolvedCommand) {
      try {
        await client.session.command({ sessionID, name: resolvedCommand.command, text: resolvedCommand.arguments || '' });
      } catch (error) {
        throw markGoalPartial(error);
      }
    } else {
      let landedMessageID = null;
      try {
        let promptInput: SessionPromptInput = { sessionID, text: expandedPrompt };
        if (promptedBySessionId) promptInput = { ...promptInput, metadata: { openchamber: { promptedBy: await readPromptOrigin(client, promptedBySessionId) } } };
        const sent = await client.session.prompt(promptInput);
        landedMessageID = asNonEmptyString(sent?.id);
        if (goalInput.enabled) await client.session.synthetic({ sessionID, text: buildGoalIntroText(goalInput.tokenBudget), resume: false });
      } catch (error) {
        throw markGoalPartial(error);
      }
      if (!landedMessageID) return {
        model, agent, variant, promptDispatched: false, dispatchedAsCommand: false,
        promptError: 'OpenCode accepted the prompt but returned no queued message',
      };
    }
    return { model, agent, variant, promptDispatched: true, dispatchedAsCommand: Boolean(resolvedCommand) };
  };
}
