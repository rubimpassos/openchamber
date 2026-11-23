import React from 'react';

import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { usePendingQuestion } from '@/sync/pending-questions';

export type PendingRequests = { hasPermission: boolean; hasForm: boolean };

export const usePendingRequests = (sessionIds: readonly string[]): PendingRequests => {
  const hasPermission = useGlobalBlockingRequestsStore(React.useCallback(
    (state) => sessionIds.some((id) => Boolean(state.bySession.get(id)?.permissions.length)),
    [sessionIds],
  ));
  const hasForm = useGlobalBlockingRequestsStore(React.useCallback(
    (state) => sessionIds.some((id) => {
      const pending = state.bySession.get(id);
      return Boolean(pending?.forms.length || pending?.pages.length);
    }),
    [sessionIds],
  ));
  // A question a restart or the inactivity eviction cut off waits like a form.
  const hasPendingQuestion = usePendingQuestion(sessionIds);
  return { hasPermission, hasForm: hasForm || hasPendingQuestion };
};
