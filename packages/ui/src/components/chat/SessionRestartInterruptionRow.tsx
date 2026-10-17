import React from 'react';
import { useComposerStatusChip } from '@/components/chat/composer/state/composerStatusChips';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isSessionPriority } from '@/lib/sessionPriority';
import { cn } from '@/lib/utils';
import { getRestartInterruption, type RestartInterruption, type RestartInterruptionCause } from '@/lib/sessionRestartInterruption';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { dismissRestartInterruption } from '@/sync/session-actions';
import { useSession, useSessionStatus } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';

interface SessionRestartInterruptionRowProps {
  sessionId: string | null;
  directory?: string;
  /** Puts a message in the composer for the user to edit and send. */
  onContinue: (text: string) => void;
}

const CAUSE_KEYS = {
  'memory-pressure': 'chat.restartInterruption.cause.memoryPressure',
  'health-timeout': 'chat.restartInterruption.cause.healthTimeout',
  'process-exited': 'chat.restartInterruption.cause.processExited',
  unknown: null,
} as const satisfies Record<RestartInterruptionCause, I18nKey | null>;

type ResumeLine = { key: I18nKey; params?: { time: string } };

/** The line a priority session shows about the server's automatic resume. */
const resumeLine = (interruption: RestartInterruption, formatTime: (timestamp: number) => string) => {
  const { resume } = interruption;
  if (!resume || resume.state === 'waiting') {
    return interruption.cause === 'memory-pressure'
      ? { key: 'chat.restartInterruption.resume.waitingMemory' } satisfies ResumeLine
      : { key: 'chat.restartInterruption.resume.waiting' } satisfies ResumeLine;
  }
  if (resume.state === 'sent') {
    return { key: 'chat.restartInterruption.resume.sent', params: { time: formatTime(resume.at) } } satisfies ResumeLine;
  }
  return { key: MANUAL_REASON_KEYS[resume.reason ?? 'send-failed'] } satisfies ResumeLine;
};

const MANUAL_REASON_KEYS = {
  'memory-timeout': 'chat.restartInterruption.resume.memoryTimeout',
  'memory-unreadable': 'chat.restartInterruption.resume.memoryUnreadable',
  'send-failed': 'chat.restartInterruption.resume.failed',
} as const satisfies Record<NonNullable<NonNullable<RestartInterruption['resume']>['reason']>, I18nKey>;

interface RestartInterruptionNoticeProps {
  interruption: RestartInterruption;
  /** A priority session: the server resumes it on its own, and the notice is stronger. */
  priority: boolean;
  /** A time as the user reads clocks. */
  formatTime: (timestamp: number) => string;
  dismissing: boolean;
  onContinue: (text: string) => void;
  onDismiss: () => void;
}

/** What the notice shows for one restart record. */
export const RestartInterruptionNotice: React.FC<RestartInterruptionNoticeProps> = ({ interruption, priority, formatTime, dismissing, onContinue, onDismiss }) => {
  const { t } = useI18n();
  const causeKey = CAUSE_KEYS[interruption.cause];
  const toolText = interruption.tool ? (interruption.tool.input || interruption.tool.name) : null;
  const resume = priority ? resumeLine(interruption, formatTime) : null;
  // Once the server sent the resume, a manual one would repeat it.
  const canContinue = !priority || interruption.resume?.state !== 'sent';

  const handleContinue = () => {
    onContinue(toolText
      ? t('chat.restartInterruption.promptWithTool', { tool: toolText })
      : t('chat.restartInterruption.prompt'));
  };

  return (
    <div
      className={cn(
        'flex items-start gap-2 border-b py-2 ps-3 pe-1.5',
        priority ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)]' : 'border-border/60',
      )}
      data-priority={priority ? 'true' : undefined}
    >
      <Icon name={priority ? 'flag' : 'error-warning'} className="mt-0.5 size-3.5 shrink-0 text-[var(--status-warning)]" />
      <div className={cn('min-w-0 flex-1 text-sm', priority ? 'text-foreground' : 'text-muted-foreground')}>
        {priority ? <p className="font-medium text-[var(--status-warning)]">{t('chat.restartInterruption.priorityLabel')}</p> : null}
        <p>
          {t('chat.restartInterruption.text', { time: formatTime(interruption.at) })}
          {causeKey ? <> {t(causeKey)}</> : null}
        </p>
        {toolText ? (
          <p className="mt-0.5 flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">{t('chat.restartInterruption.toolLabel')}</span>
            <code className="min-w-0 truncate font-mono text-xs text-foreground/80" title={toolText}>{toolText}</code>
          </p>
        ) : null}
        {resume ? <p className="mt-0.5">{'params' in resume ? t(resume.key, resume.params) : t(resume.key)}</p> : null}
      </div>
      {canContinue ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleContinue}
          onMouseDown={(event) => event.preventDefault()}
          className="shrink-0 text-foreground/80 hover:bg-transparent hover:text-foreground"
        >
          {t('chat.restartInterruption.continue')}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={dismissing}
        onClick={onDismiss}
        onMouseDown={(event) => event.preventDefault()}
        className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        {t('chat.restartInterruption.dismiss')}
      </Button>
    </div>
  );
};

/**
 * A managed OpenCode restart killed this session's running turn. The notice
 * says when and why, and which command was running; Continue fills the
 * composer with a message asking the agent to check what already happened
 * before repeating anything. For an ordinary session nothing is sent on its
 * own; a priority session also shows how the server's automatic resume went.
 * The record goes away with the next message or Dismiss.
 */
export const SessionRestartInterruptionRow: React.FC<SessionRestartInterruptionRowProps> = React.memo(({ sessionId, directory, onContinue }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? '', directory);
  const status = useSessionStatus(sessionId ?? '', directory);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [pending, setPending] = React.useState(false);
  const interruption = getRestartInterruption(session);
  const priority = isSessionPriority(session);
  const visible = Boolean(sessionId && interruption && (!status || status.type === 'idle'));

  useComposerStatusChip('interrupted', visible ? { icon: 'error-warning', label: t('chat.composerStatus.chip.interrupted') } : null);

  if (!visible || !sessionId || !interruption) return null;

  const handleDismiss = async () => {
    if (pending) return;
    setPending(true);
    try {
      await dismissRestartInterruption(sessionId, directory);
    } catch {
      toast.error(t('chat.restartInterruption.dismissFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <RestartInterruptionNotice
      interruption={interruption}
      priority={priority}
      formatTime={(timestamp) => formatTimeForPreference(timestamp, timeFormatPreference)}
      dismissing={pending}
      onContinue={onContinue}
      onDismiss={() => { void handleDismiss(); }}
    />
  );
});

SessionRestartInterruptionRow.displayName = 'SessionRestartInterruptionRow';
