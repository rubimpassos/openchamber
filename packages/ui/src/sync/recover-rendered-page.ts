import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { laterPageSchema } from './later-pages';
import { hydrateLaterPages } from './later-pages-sync';
import { retry } from './retry';

const recoverySchema = z.object({ page: laterPageSchema.nullable() });
const errorSchema = z.object({ error: z.string() });

export async function recoverRenderedPage(
    input: { readonly sessionId: string; readonly messageId: string; readonly callId: string },
    signal: AbortSignal,
): Promise<void> {
    const isCurrentRuntime = captureRuntimeInstance();
    await retry(async () => {
        if (!isCurrentRuntime()) throw new DOMException('The runtime changed during page recovery', 'AbortError');
        const response = await runtimeFetch('/api/openchamber/render/recover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) {
            const error = errorSchema.safeParse(await response.json().catch(() => null));
            throw Object.assign(new Error(error.success ? error.data.error : `Page recovery failed (${response.status})`), { status: response.status });
        }
        const { page } = recoverySchema.parse(await response.json());
        if (page && isCurrentRuntime() && !signal.aborted) await hydrateLaterPages(signal);
    }, {
        signal,
        retryIf: (error) => {
            if (error instanceof DOMException) return error.name === 'TimeoutError';
            if (error instanceof TypeError) return true;
            if (!(error instanceof Error) || !('status' in error) || typeof error.status !== 'number') return false;
            return error.status >= 500 || error.status === 408 || error.status === 429;
        },
    });
}
