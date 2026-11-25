import { asNonEmptyString } from '../shared/guards.js';
import type { RequestHandler } from '../shared/http-contracts.js';
import type { ControlOptions } from '../openchamber-control/service.js';
import type { AgentToolPayload, ResultFields } from './runtime.js';
import { createRenderCaptureReply } from './render-capture.js';

type CallbackOwners = {
  readonly execute: (payload: AgentToolPayload, options: ControlOptions) => Promise<ResultFields & { schemaVersion: number }>;
  readonly createResult: (fields: ResultFields) => ResultFields & { schemaVersion: number };
  readonly trackInflight: (sessionId: string | null, controller: AbortController) => () => void;
};

export function createAgentToolCallback({ execute, createResult, trackInflight }: CallbackOwners): RequestHandler<AgentToolPayload> {
  return async (req, res) => {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    const untrack = trackInflight(asNonEmptyString(req.body?.sessionID), controller);
    const captureReply = req.body?.tool === 'openchamber_render' ? createRenderCaptureReply(req, res) : null;
    const reply = captureReply?.reply ?? ((result: ResultFields) => res.json(result));
    try {
      return reply(await execute(req.body, { signal: controller.signal, onArtifactCaptured: captureReply?.onArtifactCaptured }));
    } catch (error) {
      return reply(createResult({
        ok: false, action: req.body?.input?.action,
        error: { message: error instanceof Error ? error.message : String(error), kind: 'runtime' },
      }));
    } finally {
      untrack();
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    }
  };
}
