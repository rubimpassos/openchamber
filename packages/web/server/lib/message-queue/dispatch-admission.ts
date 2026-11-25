import { z } from 'zod';
import { asNonEmptyString, isRecord } from '../shared/guards.js';
import type { SessionDispatchAdmission, SessionNativeDispatch } from '../openchamber-sessions/dispatch-admission.js';
import type { MessageQueueOptions, QueuedItem } from './runtime.js';

type QueueWrite = {
  readonly directory?: string | undefined;
  readonly method?: string;
  readonly body?: object;
  readonly query?: Record<string, string>;
};
type QueueDispatchPorts = {
  readonly getAdmission: () => SessionDispatchAdmission | undefined;
  readonly getNative: () => SessionNativeDispatch | undefined;
  readonly isHeld: (sessionId: string) => boolean;
  readonly assertFixLoopHostDispatch: MessageQueueOptions['assertFixLoopHostDispatch'];
  readonly write: (route: string, request: QueueWrite | undefined) => Promise<void>;
};

export function createQueuedSessionDispatch(ports: QueueDispatchPorts) {
  return (sessionId: string, directory: string, item: QueuedItem) => {
    const assertAdmission = async () => {
      if (item.origin?.kind !== 'bot') await ports.getAdmission()?.({
        sessionId, directory, operationId: `queue:${item.id}`, text: item.text,
        payload: { text: item.text, attachments: item.attachments, context: item.context, sendConfig: item.sendConfig, goal: item.goal ?? null },
        selection: item.sendConfig.providerID && item.sendConfig.modelID ? item.sendConfig : undefined,
      });
      if (item.origin?.kind === 'pr-fix-loop') {
        if (!ports.assertFixLoopHostDispatch) throw Object.assign(new Error('Fix-loop host dispatch authority is unavailable'), { status: 409 });
        await ports.assertFixLoopHostDispatch(sessionId, directory, item.origin);
      }
      if (ports.isHeld(sessionId)) throw Object.assign(new Error('Queued delivery is held'), { status: 409 });
    };
    const write = async (route: string, request?: QueueWrite) => {
      await assertAdmission();
      const nativeDispatch = ports.getNative();
      if (nativeDispatch) {
        const operation = z.enum(['prompt', 'command', 'synthetic', 'model', 'agent']).safeParse(route.split('/').at(-1));
        if (operation.success) {
          const body = isRecord(request?.body) ? request.body : null;
          const dispatched = await nativeDispatch({ sessionId, directory, operation: operation.data,
            operationId: `queue:${item.id}:${operation.data}:${asNonEmptyString(body?.id) ?? ''}`,
            admissionId: `queue:${item.id}`, payload: request?.body, text: item.text });
          if (dispatched) return;
        }
      }
      await ports.write(route, request);
    };
    return { assertAdmission, write };
  };
}
