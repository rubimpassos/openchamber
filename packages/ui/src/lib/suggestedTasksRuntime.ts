import { useSyncExternalStore } from 'react';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

let controller = new AbortController();
let scope = { generation: 0, signal: controller.signal };
const listeners = new Set<() => void>();
let observedWindow: Window | null = null;
let releaseEndpoint: (() => void) | undefined;

const observeEndpoint = () => {
  if (!globalThis.window || observedWindow === window) return;
  releaseEndpoint?.();
  observedWindow = window;
  releaseEndpoint = subscribeRuntimeEndpointChanged(({ runtimeKey, previousRuntimeKey }) => {
    if (runtimeKey === previousRuntimeKey) return;
    controller.abort();
    controller = new AbortController();
    scope = { generation: scope.generation + 1, signal: controller.signal };
    for (const listener of listeners) listener();
  });
};

/** A switch retires this exact lifetime, including an A to B to A switch. */
export const getSuggestedTasksRuntime = () => {
  observeEndpoint();
  return scope;
};

export type SuggestedTasksRuntime = ReturnType<typeof getSuggestedTasksRuntime>;

export const subscribeSuggestedTasksRuntime = (listener: () => void) => {
  observeEndpoint();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useSuggestedTasksRuntime = () => useSyncExternalStore(subscribeSuggestedTasksRuntime, getSuggestedTasksRuntime);
