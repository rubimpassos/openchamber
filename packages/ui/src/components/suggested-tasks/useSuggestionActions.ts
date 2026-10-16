import React from 'react';
import { toast } from '@/components/ui';
import type { ProjectEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import {
  approveSuggestion, dismissSuggestion, restoreSuggestion, runSuggestionScan, snoozeSuggestion, stopSuggestionScan,
  type Suggestion,
} from '@/lib/suggestedTasksApi';
import { getSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { openExternalUrl } from '@/lib/url';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { useSuggestedTasksStore } from '@/stores/useSuggestedTasksStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SuggestedTasksLeaveReason } from './SuggestedTasksPage';
import type { SuggestionDecision } from './SuggestionCard';

/** Async UI continuations belong to the inbox visit that admitted them. */
export const useSuggestionActions = (project: ProjectEntry, onLeave: (reason: SuggestedTasksLeaveReason) => void) => {
  const { t } = useI18n();
  const runtime = getSuggestedTasksRuntime();
  const active = React.useRef(true);
  const pending = React.useRef(new Set<string>());
  const [busyIds, setBusyIds] = React.useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = React.useState(false);
  const [dismissTarget, setDismissTarget] = React.useState<Suggestion | null>(null);
  React.useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const current = () => active.current && !runtime.signal.aborted;
  const latestSuggestion = (suggestion: Suggestion): Suggestion => {
    const entry = useSuggestedTasksStore.getState().inboxes[project.id];
    const inbox = entry && entry.status !== 'loading' ? entry.inbox : null;
    return inbox?.suggestions.find((item) => item.id === suggestion.id) ?? suggestion;
  };
  const openSession = (sessionId: string, directory?: string) => {
    if (!current()) return;
    void refreshGlobalSessions();
    useSessionUIStore.getState().setCurrentSession(sessionId, directory ?? project.path);
    onLeave('session');
  };
  const runNow = async () => {
    if (!current() || pending.current.has('scan')) return;
    pending.current.add('scan');
    setRunning(true);
    try {
      await runSuggestionScan(project.id);
      if (runtime.signal.aborted) return;
      await useSuggestedTasksStore.getState().loadInbox(project.id, true);
      if (current()) toast.success(t('suggestedTasks.toast.scanStarted'));
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('suggestedTasks.toast.scanFailed'));
    } finally {
      pending.current.delete('scan');
      if (current()) setRunning(false);
    }
  };
  const stop = async (runId: string) => {
    if (!current()) return;
    try {
      await stopSuggestionScan(project.id, runId);
      if (!runtime.signal.aborted) await useSuggestedTasksStore.getState().loadInbox(project.id, true);
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('suggestedTasks.toast.actionFailed'));
    }
  };
  const decide = async (source: Suggestion, decision: SuggestionDecision) => {
    if (!current() || pending.current.has(source.id)) return;
    const suggestion = latestSuggestion(source);
    const viewing = decision.kind === 'open-session' || decision.kind === 'open-issue';
    const recovering = decision.kind === 'restore' && Boolean(suggestion.conversionRecoverable);
    if (suggestion.conversionPending && !viewing && !recovering) return;
    const conversion = suggestion.conversion;
    switch (decision.kind) {
      case 'dismiss': setDismissTarget(suggestion); return;
      case 'open-session': if (conversion?.sessionId) openSession(conversion.sessionId, conversion.directory); return;
      case 'open-issue': if (conversion?.url) void openExternalUrl(conversion.url); return;
      case 'snooze': case 'restore': case 'approve': break;
      default: { const exhaustive: never = decision; return exhaustive; }
    }
    pending.current.add(suggestion.id);
    setBusyIds(new Set(pending.current));
    try {
      let updated: Suggestion;
      switch (decision.kind) {
        case 'snooze': updated = await snoozeSuggestion(project.id, suggestion.id, decision.until); break;
        case 'restore': updated = await restoreSuggestion(project.id, suggestion.id); break;
        case 'approve': updated = await approveSuggestion(project.id, suggestion.id, decision.action, decision.provider); break;
        default: { const exhaustive: never = decision; return exhaustive; }
      }
      useSuggestedTasksStore.getState().applySuggestion(project.id, updated, runtime);
      if (!current() || decision.kind !== 'approve') return;
      if (updated.conversion?.sessionId) openSession(updated.conversion.sessionId, updated.conversion.directory);
      else if (updated.conversion?.url) void openExternalUrl(updated.conversion.url);
      else if (decision.action === 'draft') {
        const files = suggestion.files.map((file) => `- ${file.path}${file.startLine ? `:${file.startLine}` : ''}`).join('\n');
        useSessionUIStore.getState().openNewSessionDraft({
          selectedProjectId: project.id, directoryOverride: project.path,
          initialPrompt: [`## ${suggestion.title}`, suggestion.body, files ? `Files:\n${files}` : ''].filter(Boolean).join('\n\n'),
        });
        onLeave('draft');
      } else if (decision.action === 'todo') toast.success(t('suggestedTasks.toast.todoAdded'));
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('suggestedTasks.toast.actionFailed'));
    } finally {
      pending.current.delete(suggestion.id);
      if (current()) setBusyIds(new Set(pending.current));
    }
  };
  const dismiss = async (reason: string): Promise<boolean> => {
    if (!current() || !dismissTarget || pending.current.has(dismissTarget.id)) return false;
    const latest = latestSuggestion(dismissTarget);
    if (latest.conversionPending) return false;
    if (latest.status !== 'open' && latest.status !== 'snoozed') {
      setDismissTarget(null);
      return false;
    }
    const id = dismissTarget.id;
    pending.current.add(id);
    setBusyIds(new Set(pending.current));
    try {
      const suggestion = await dismissSuggestion(project.id, id, reason);
      useSuggestedTasksStore.getState().applySuggestion(project.id, suggestion, runtime);
      return current();
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('suggestedTasks.toast.actionFailed'));
      return false;
    } finally {
      pending.current.delete(id);
      if (current()) setBusyIds(new Set(pending.current));
    }
  };
  return { decide, dismiss, runNow, stop, openSession, busyIds, running, dismissTarget, setDismissTarget };
};
