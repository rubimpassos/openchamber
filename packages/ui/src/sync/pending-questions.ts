import React from 'react';
import { create } from 'zustand';

import type { Session } from '@/lib/opencode/model';
import { getPendingQuestion } from '@/lib/questions/pendingQuestion';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useGlobalSessionStatusStore } from './global-session-status';

/**
 * Sessions whose question a restart or the inactivity eviction cut off, still
 * waiting for the user's answer. The one authority is the session record's
 * `metadata.openchamber.pendingQuestion` (`@/lib/questions/pendingQuestion`),
 * which the global session list already carries, so every "waiting for you"
 * surface can show these without loading a session's messages.
 *
 * OpenCode reports such a session idle. This is the one place where an idle
 * session counts as waiting, and only while the record says so: the entry
 * goes when the record goes (answer, dismiss, a sent message, the session
 * running again), and a session reported busy or retrying never counts.
 */
type PendingQuestionEntry = { directory: string; title: string; callID: string };

type PendingQuestionsState = { bySession: ReadonlyMap<string, PendingQuestionEntry> };

export const usePendingQuestionsStore = create<PendingQuestionsState>(() => ({ bySession: new Map() }));

const sameEntries = (left: ReadonlyMap<string, PendingQuestionEntry>, right: ReadonlyMap<string, PendingQuestionEntry>) => {
  if (left.size !== right.size) return false;
  for (const [sessionId, entry] of left) {
    const other = right.get(sessionId);
    if (!other || other.callID !== entry.callID || other.directory !== entry.directory || other.title !== entry.title) return false;
  }
  return true;
};

const collect = (sessions: Iterable<Session>): Map<string, PendingQuestionEntry> => {
  const next = new Map<string, PendingQuestionEntry>();
  for (const session of sessions) {
    const question = getPendingQuestion(session);
    if (!question) continue;
    next.set(session.id, { directory: resolveGlobalSessionDirectory(session) ?? session.directory, title: question.title, callID: question.callID });
  }
  return next;
};

/** Rebuilds the entries from the global session list; a no-op publishes nothing. */
export const syncPendingQuestions = (sessions: Iterable<Session>): void => {
  const next = collect(sessions);
  if (sameEntries(usePendingQuestionsStore.getState().bySession, next)) return;
  usePendingQuestionsStore.setState({ bySession: next });
};

/** Keeps the entries in step with the global session list. Returns the unsubscribe. */
export const startPendingQuestionsSync = (): (() => void) => {
  let entities = useGlobalSessionsStore.getState().entityById;
  syncPendingQuestions(entities.values());
  return useGlobalSessionsStore.subscribe((state) => {
    if (state.entityById === entities) return;
    entities = state.entityById;
    syncPendingQuestions(entities.values());
  });
};

const isRunning = (statusById: ReturnType<typeof useGlobalSessionStatusStore.getState>['statusById'], sessionId: string): boolean => {
  const type = statusById.get(sessionId)?.status.type;
  return type === 'busy' || type === 'retry';
};

/** Every session whose cut-off question waits for the user now; for non-React readers (the tray). */
export const listPendingQuestions = (): Array<[string, PendingQuestionEntry]> => {
  const { statusById } = useGlobalSessionStatusStore.getState();
  return [...usePendingQuestionsStore.getState().bySession].filter(([sessionId]) => !isRunning(statusById, sessionId));
};

/** Whether a cut-off question waits for the user in any of these sessions. */
export const usePendingQuestion = (sessionIds: Iterable<string>): boolean => {
  const ids = React.useMemo(() => [...sessionIds], [sessionIds]);
  const listed = usePendingQuestionsStore(React.useCallback(
    (state) => ids.filter((id) => state.bySession.has(id)).join('\0'),
    [ids],
  ));
  return useGlobalSessionStatusStore(React.useCallback((state) => (
    listed !== '' && listed.split('\0').some((id) => !isRunning(state.statusById, id))
  ), [listed]));
};
