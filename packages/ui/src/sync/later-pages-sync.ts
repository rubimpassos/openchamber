import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { applyLaterPages, applyLaterPagesSnapshot, laterPagesSnapshotSchema } from './later-pages';

const isLaterPagesAvailable = (): boolean => !isVSCodeRuntime();

export const hydrateLaterPages = async (signal?: AbortSignal): Promise<void> => {
  if (!isLaterPagesAvailable()) return;
  const isCurrentRuntime = captureRuntimeInstance();
  const timeout = AbortSignal.timeout(15_000);
  const response = await runtimeFetch('/api/openchamber/render/later', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw Object.assign(new Error(`Later pages failed to load (${response.status})`), { status: response.status });
  const parsed = laterPagesSnapshotSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Invalid later pages response');
  if (!isCurrentRuntime()) return;
  applyLaterPagesSnapshot(parsed.data);
};

export const subscribeLaterPagesSync = (runtimeKey: string): (() => void) => {
  if (!isLaterPagesAvailable()) return () => undefined;
  void hydrateLaterPages().catch(() => undefined);
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getRuntimeKey()) return;
    if (event.type === 'event-stream-ready') void hydrateLaterPages().catch(() => undefined);
    else if (event.type === 'openchamber:render-later.updated') {
      applyLaterPages(event.properties.revision, event.properties.sessionID, event.properties.pages);
    }
  });
};
