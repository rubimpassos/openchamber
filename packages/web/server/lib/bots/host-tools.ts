import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { isolatedBotToolPageSchema, isolatedBotToolReceiptSchema } from './isolated-tools.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { BotServiceError } from './services/contracts.js';
import { hasProperties } from '../shared/guards.js';
import type { BotServiceReply } from '../agent-server/bot-service-contract.js';
import type { JsonValue } from '../shared/json-values.js';

type PendingTool = z.output<typeof isolatedBotToolPageSchema>['requests'][number];
type ToolReceipt = z.output<typeof isolatedBotToolReceiptSchema>;
type ToolReply = Extract<ToolReceipt, { state: 'settled' }>['reply'];
type HostToolEntry = {
  readonly projectId: string; readonly botId: string; readonly itemId: string;
  readonly sessionId: string; readonly directory: string; readonly isolated: boolean;
  readonly stage: 'investigation' | 'fixing' | 'judge';
};
type ToolPageInput = { readonly requests: readonly { readonly id: string; readonly request: {
  readonly sessionId: string; readonly callId: string; readonly action: string; readonly input: JsonValue;
} }[] };
type HostToolsOptions = {
  readonly dataDir: string;
  readonly execution: {
    readSession(entry: HostToolEntry): Promise<BotServiceReply<'session'>>;
    pullTools(entry: HostToolEntry): Promise<ToolPageInput>;
    settleTool(entry: HostToolEntry, settlement: PendingTool & { readonly reply: ToolReply }): Promise<{ readonly settled: boolean } | null | undefined>;
  };
  readonly handleTool: (request: Omit<PendingTool['request'], 'callId'>) => Promise<z.output<ReturnType<typeof z.json>>>;
  readonly readToolOutcome?: ((request: PendingTool['request']) => Promise<
    { readonly state: 'succeeded'; readonly result: z.output<ReturnType<typeof z.json>> } | { readonly state: 'outcome-unknown' }
  >) | undefined;
};
const refuse: (code: string) => never = (code) => { throw new BotServiceError(code, 'The recorded Bot tool call needs owner attention.'); };
type ErrorCodePattern = { test(cause: unknown): boolean };
type ErrorStateSet = { includes(cause: unknown): boolean };
const publicCode: ErrorCodePattern = /^BOT_[A-Z0-9_]+$|^enterprise_mode$/;
const publicStates: ErrorStateSet = ['needs-you', 'outcome-unknown', 'failed', 'refused'];

export function createBotHostTools({ dataDir, execution, handleTool, readToolOutcome }: HostToolsOptions) {
  const receipts = createBotAdapterState({ dataDir, name: 'host-tool-receipts', schema: isolatedBotToolReceiptSchema });
  const forward = async (entry: HostToolEntry) => {
    if (entry.isolated || entry.stage !== 'fixing') refuse('BOT_FIXING_SESSION_REQUIRED');
    const session = await execution.readSession(entry);
    const marker = session.metadata?.openchamber?.automation;
    if (session.id !== entry.sessionId || session.directory !== entry.directory || session.archived
      || marker?.source !== 'bot' || marker.projectId !== entry.projectId || marker.botId !== entry.botId
      || marker.itemId !== entry.itemId || marker.stage !== 'fixing') refuse('BOT_FIXING_SESSION_REQUIRED');
    const page = isolatedBotToolPageSchema.parse(await execution.pullTools(entry));
    if (page.requests.some(({ id, request }) => request.sessionId !== entry.sessionId
      || id !== digestMutationInput({ sessionId: request.sessionId, callId: request.callId }))) refuse('BOT_HOST_TOOL_CHANGED');
    let forwarded = 0;
    for (const pending of page.requests) {
      const key = { projectId: entry.projectId, itemId: entry.itemId, sessionId: entry.sessionId, id: pending.id };
      await receipts.own(key, async () => {
        const receipt = await receipts.read(key);
        if (receipt && digestMutationInput(receipt.request) !== digestMutationInput(pending.request)) refuse('BOT_HOST_TOOL_CHANGED');
        let reply: ToolReply;
        if (receipt?.state === 'dispatching') {
          const recovered = await readToolOutcome?.(receipt.request);
          if (recovered?.state !== 'succeeded') refuse('BOT_HOST_TOOL_OUTCOME_UNKNOWN');
          reply = { ok: true, result: recovered.result };
          await receipts.write(key, { ...pending, state: 'settled', reply });
        } else if (!receipt) {
          await receipts.write(key, { ...pending, state: 'dispatching' });
          let captured;
          try { captured = { ok: true, result: z.json().parse(await handleTool({ sessionId: entry.sessionId,
            action: pending.request.action, input: pending.request.input })) }; }
          catch (error) {
            const fields = hasProperties(error) ? error : undefined;
            const code = publicCode.test(fields?.code ?? '') ? fields?.code : 'BOT_HOST_TOOL_REFUSED';
            captured = { ok: false, error: { code, status: Number(fields?.status) >= 400 && Number(fields?.status) <= 599 ? fields?.status : 409,
              state: publicStates.includes(fields?.state) ? fields?.state : 'needs-you' } };
          }
          const saved = await receipts.write(key, { ...pending, state: 'settled', reply: captured });
          if (saved.state !== 'settled') throw new TypeError('The host tool receipt was not settled');
          reply = saved.reply;
        } else reply = receipt.reply;
        const settled = await execution.settleTool(entry, { ...pending, reply });
        if (settled?.settled !== true) refuse('BOT_HOST_TOOL_SETTLEMENT_UNKNOWN');
        forwarded++;
      });
    }
    return { forwarded };
  };
  return { forward };
}
