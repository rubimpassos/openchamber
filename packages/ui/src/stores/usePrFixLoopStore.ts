import React from 'react';
import { useStore } from 'zustand';
import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { prFixLoopApi } from '@/lib/prFixLoopApi';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { createPrFixLoopProjection } from './prFixLoopProjection';

export const prFixLoopStore = createPrFixLoopProjection({ api: prFixLoopApi, runtimeKey: getRuntimeKey });
type State = ReturnType<typeof prFixLoopStore.getState>;

export function usePrFixLoopStore<T>(selector: (state: State) => T): T {
  return useStore(prFixLoopStore, selector);
}

let consumers = 0;
let release: (() => void) | null = null;

// Invalidate pending requests even after their last view unmounts, including A → B → A.
subscribeRuntimeEndpointWillChange(() => prFixLoopStore.getState().reset());
subscribeRuntimeEndpointChanged(() => {
  prFixLoopStore.getState().reset();
  if (consumers > 0) void prFixLoopStore.getState().refresh();
});

/** Shared with the queue's control stream. Mounted views add no per-PR traffic. */
function acquireProjection() {
  if (isVSCodeRuntime()) return;
  consumers += 1;
  if (consumers === 1) {
    const refresh = () => { void prFixLoopStore.getState().refresh(); };
    const stopEvents = subscribeOpenchamberEvents((event) => {
      if (event.type === 'event-stream-ready') refresh();
      else if (event.type === 'openchamber:pr-fix-loop.updated') {
        prFixLoopStore.getState().applyEvent(event, getRuntimeKey());
      }
    });
    refresh();
    release = stopEvents;
  }
  return () => {
    consumers -= 1;
    if (consumers === 0) {
      release?.();
      release = null;
    }
  };
}

export function usePrFixLoopProjection(enabled = true): void {
  React.useEffect(() => enabled ? acquireProjection() : undefined, [enabled]);
}
