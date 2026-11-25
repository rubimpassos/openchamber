import { resolveSessionDefaults } from '../scheduled-tasks/session-defaults.js';
import type { SessionDefaultSettings } from '../scheduled-tasks/session-defaults.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { isRecord, isString } from '../shared/guards.js';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';
import type { BotServiceReply } from '../agent-server/bot-service-contract.js';

type DefaultsOwners = {
  readonly readSettings: () => Promise<SessionDefaultSettings>;
  readonly resolveProject: (projectId: string) => Promise<SessionDefaultSettings & { readonly path: string }>;
  readonly clientFor: (directory: string) => Pick<SessionClient, 'model'>;
};

export function createBotSessionDefaults({ readSettings, resolveProject, clientFor }: DefaultsOwners) {
  return async (projectId: string) => {
    const settings = await readSettings();
    const project = await resolveProject(projectId);
    const defaults = resolveSessionDefaults({ settings, project });
    if (!defaults.providerID || !defaults.modelID) {
      const model = unwrapOpenCodeResponse(await clientFor(project.path).model.default());
      if (!isRecord(model) || !isString(model.providerID) || !isString(model.id)) {
        throw new OpenChamberControlError('OpenCode did not return a default model', 503);
      }
      defaults.providerID = model.providerID;
      defaults.modelID = model.id;
    }
    const selection: BotServiceReply<'defaults'> = { providerID: defaults.providerID, modelID: defaults.modelID };
    if (defaults.variant) selection.variant = defaults.variant;
    if (defaults.agent) selection.agent = defaults.agent;
    return selection;
  };
}
