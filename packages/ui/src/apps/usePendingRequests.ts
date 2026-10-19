import React from 'react';

import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { usePendingQuestion } from '@/sync/pending-questions';

export type PendingRequests = { hasPermission: boolean; hasForm: boolean };

/**
 * Whether a permission request or a form waits for a row. The answer comes
 * from the cross-directory request index, so a project the phone never opened
 * still shows them. `sessionIds` is the row's own session plus any subsessions
 * it hides: a subagent's request blocks the whole family.
 */
export const usePendingRequests = (sessionIds: readonly string[]): PendingRequests => {
  const hasPermission = useGlobalBlockingRequestsStore(React.useCallback(
    (state) => sessionIds.some((id) => Boolean(state.bySession.get(id)?.permissions.length)),
    [sessionIds],
  ));
  const hasForm = useGlobalBlockingRequestsStore(React.useCallback(
    // A page that waits for the user's answer counts as a form.
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
