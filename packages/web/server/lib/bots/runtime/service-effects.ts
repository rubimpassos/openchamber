import { z } from 'zod';
import { botInputDigest } from '../effects.js';
import { botServiceReceipt } from '../service-receipts.js';
import { operations } from '../services/contracts.js';
import { contextSchema, pendingToolSchema } from './input-contracts.js';
import { serviceRequestSchema } from './journal.js';
import { requireDefinition } from './invariants.js';
import { runtimeError as error } from './errors.js';
import type { BotItem } from '../schema.js';
import type { BotOperation } from '../services/contracts.js';
import type { JsonValue } from '../../shared/json-values.js';
import type { RuntimeBot, RuntimeServiceRequest } from './contracts.js';
import type { RuntimeContext } from './context.js';
import type { RuntimeProject, RuntimeServiceContext } from './input-contracts.js';

export const createRuntimeServiceEffects = ({ journal, itemFor, effects, services, serviceContext }: RuntimeContext) => {
  const { saveData } = journal;
  return async (projectId: string, project: RuntimeProject, bot: RuntimeBot, item: BotItem, key: string, operation: BotOperation, input: JsonValue, { binding: fixedBinding, beforeDispatch, tool = false }: {
    readonly binding?: NonNullable<RuntimeServiceContext['github']>;
    readonly beforeDispatch?: () => Promise<void>;
    readonly tool?: boolean;
  } = {}) => {
    const execution = await journal.read(projectId, item.id);
    const current = await itemFor(projectId, item.id);
    const effect = current.effects.find((entry) => entry.key === key);
    let request = execution.operations[key] ? serviceRequestSchema.parse(execution.operations[key]) : undefined;
    if (!['pr.disable-auto-merge', 'pr.dequeue'].includes(operation)
      && (!effect || effect.state === 'prepared')
      && current.effects.some((entry) => entry.key !== key && ['dispatching', 'outcome-unknown'].includes(entry.state))) throw error('BOT_EFFECT_UNSETTLED');
    if (tool && effect?.state !== 'succeeded') {
      const pendingTool = execution.data.pendingTool ? pendingToolSchema.parse(execution.data.pendingTool) : null;
      if (pendingTool && pendingTool.key !== key && (!effect || effect.state === 'prepared')) throw error('BOT_EFFECT_UNSETTLED');
      if (!pendingTool || pendingTool.key === key) await saveData(projectId, item.id, { pendingTool: pendingToolSchema.parse({ key, operation, input: request?.input ?? input }) });
    }
    if (!request) {
      const service = operation.startsWith('jira.') ? 'jira' : operation === 'discord.send' ? 'discord' : 'github';
      const context = fixedBinding ? { github: fixedBinding } : contextSchema.parse(await serviceContext({ project, bot: requireDefinition(bot), item, service, operation }));
      const binding = context[service];
      if (!binding) throw error('BOT_IDENTITY_REQUIRED');
      const captured = execution.data.destinations?.[service];
      const identity = { identityId: binding.identityId, identityRevision: binding.identityRevision, target: binding.target };
      if (captured && botInputDigest(captured) !== botInputDigest(identity)) throw error('BOT_DESTINATION_CHANGED');
      if (!captured) await saveData(projectId, item.id, { destinations: { ...execution.data.destinations, [service]: identity } });
      const prepared = await services.prepare({ key, operation, botId: bot.id, itemId: item.id, ...identity, input });
      const candidate: Pick<RuntimeServiceRequest, 'input' | 'authorization'> & { prepared: typeof prepared } = { prepared, input: z.json().parse(JSON.parse(JSON.stringify(input))) };
      if (operation === 'pr.auto-merge') {
        const admission = (await journal.read(projectId, item.id)).data.admission;
        if (admission) candidate.authorization = admission;
      }
      request = serviceRequestSchema.parse(JSON.parse(JSON.stringify(candidate)));
    }
    const capturedAuthority = request.prepared.authority;
    const capturedRequest = request;
    const record = async (result: z.output<ReturnType<typeof z.json>>) => {
      const receipt = botServiceReceipt(capturedRequest.prepared, result);
      const latest = await journal.read(projectId, item.id);
      await saveData(projectId, item.id, { serviceResults: { ...latest.data.serviceResults, [key]: result } });
      return receipt;
    };
    const receipt = await effects.run({ projectId, itemId: item.id, key, kind: operation,
      authority: { service: capturedAuthority.service, identityId: capturedAuthority.identityId, revision: capturedAuthority.identityRevision, target: JSON.stringify(request.prepared.target) },
      request, beforeDispatch, executePrepared: async (_request, claimDispatch) => record(z.json().parse((await services.execute(capturedRequest.prepared, operations[capturedRequest.prepared.operation].input.parse(capturedRequest.input),
        { beforeAdmission: beforeDispatch, beforeDispatch: claimDispatch })).result)), reconcile: async () => {
        const result = await services.reconcile(capturedRequest.prepared, operations[capturedRequest.prepared.operation].input.parse(capturedRequest.input));
        return result.state === 'succeeded' ? { state: 'succeeded', result: await record(z.json().parse(result.result)) } : result;
      },
    });
    if ((await journal.read(projectId, item.id)).data.pendingTool?.key === key) await saveData(projectId, item.id, { pendingTool: null });
    return receipt;
  };
};
