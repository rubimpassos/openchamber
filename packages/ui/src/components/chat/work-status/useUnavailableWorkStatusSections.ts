import React from 'react';

import { BUILTIN_BROWSER_PROVIDER } from '@/lib/guests/browser-providers';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { selectWorkflowsShown } from '@/lib/workflows/availability';
import { selectSessionTodosOn, useSessionTodosStore } from '@/stores/useSessionTodosStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorkStatusSectionId } from './sections';

export const useUnavailableWorkStatusSections = (): readonly WorkStatusSectionId[] => {
  const workflows = useUIStore(selectWorkflowsShown);
  const isMobile = useUIStore((state) => state.isMobile);
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const tasks = useSessionTodosStore(selectSessionTodosOn(sessionId));
  const serverBrowser = useUIStore((state) => Boolean(state.browserProvider) && state.browserProvider !== BUILTIN_BROWSER_PROVIDER);
  const browsers = serverBrowser && !isVSCodeRuntime();
  return React.useMemo(() => [
    ...(isMobile ? ['usage' as const] : []),
    ...(workflows ? [] : ['workflows' as const]),
    ...(tasks ? [] : ['tasks' as const]),
    ...(browsers ? [] : ['browsers' as const]),
  ], [browsers, isMobile, tasks, workflows]);
};
