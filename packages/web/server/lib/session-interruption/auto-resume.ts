import { z } from 'zod';
import { isPrioritySession } from './priority.js';
import { RESTART_REASON } from './restart.js';
import type { AutoResumeOptions, InterruptedSession, InterruptedTool, ManualContinuation, RestartDetails, ResumeOutcome, ResumeTool } from './contracts.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';

const RESUME_MEMORY_CALM_FULL_AVG60 = 2;
export const RESUME_MEMORY_POLL_MS = 15_000;
export const RESUME_MEMORY_DEADLINE_MS = 10 * 60_000;

const restartRecordSchema = z.object({
  openchamber: z.object({
    interruption: z.object({
      reason: z.literal(RESTART_REASON),
      at: z.number(),
      cause: z.string().nullish().catch(null),
      tool: z.object({ name: z.string().min(1), input: z.string().nullish() }).nullish().catch(null),
      resume: z.looseObject({ state: z.enum(['waiting', 'sent', 'manual']) }).nullish(),
    }),
  }),
});

type RestartRecord = z.infer<typeof restartRecordSchema>['openchamber']['interruption'];
type ResumeState = NonNullable<RestartRecord['resume']> & { readonly at?: number; readonly reason?: string };
type ResumeSession = InterruptedSession & { readonly directory: string };
interface RecordSelection { record: RestartRecord | null }
interface CauseDescriptions { readonly [cause: string]: string }
const resumePatch = (resume: ResumeState | null) => ({ openchamber: { interruption: { resume } } });

const currentRecord = (metadata: SessionMetadata | undefined, at: number) => {
  const interruption = restartRecordSchema.safeParse(metadata).data?.openchamber.interruption;
  return interruption?.at === at ? interruption : null;
};

const CAUSE_TEXT: CauseDescriptions = {
  'memory-pressure': 'the server ran out of memory',
  'health-timeout': 'OpenCode stopped responding',
  'process-exited': 'the OpenCode process stopped',
};

export const buildResumeMessage = ({ at, cause, tool }: RestartDetails) => {
  const when = new Date(at).toISOString();
  const why = cause && CAUSE_TEXT[cause] ? ` because ${CAUSE_TEXT[cause]}` : '';
  const what = tool ? ` while \`${tool.input || tool.name}\` was running` : '';
  return [
    `OpenChamber resumed this session. OpenCode restarted at ${when}${why} and cut off your last turn${what}.`,
    'Before repeating that or any other command, check the current state: files you changed and processes you started that may still be running.',
    'Then continue from where you stopped, without redoing steps that already took effect.',
  ].join(' ');
};

const RESUME_MESSAGE_SOURCE = 'openchamber-notice';

const resumeTool = (tool: InterruptedTool | null | undefined): ResumeTool | null => {
  if (!tool) return null;
  return tool.input ? { name: tool.name, input: tool.input } : { name: tool.name };
};

const resumeMessage = ({ at, cause, tool }: RestartDetails, trigger: 'auto' | 'continue') => ({
  text: buildResumeMessage({ at, cause, tool }),
  description: 'OpenChamber resumed this session after OpenCode restarted',
  metadata: {
    source: RESUME_MESSAGE_SOURCE,
    kind: 'restart-resume',
    trigger,
    at,
    cause: cause ?? 'unknown',
    tool: resumeTool(tool),
  },
});

export const createAutoResumeRuntime = ({
  updateMetadata,
  sendPrompt,
  readMemory,
  now = Date.now,
  sleep = (ms, signal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }),
}: AutoResumeOptions) => {
  const stopping = new AbortController();
  const current = new Map<string, number>();

  const decide = (sessionId: string, directory: string, step: Parameters<AutoResumeOptions['updateMetadata']>[1]) => updateMetadata(sessionId, step, { directory });

  const waitForCalmMemory = async (isCurrent: () => boolean) => {
    const deadline = now() + RESUME_MEMORY_DEADLINE_MS;
    let previous = readMemory();
    if (!previous?.pressure) return 'unreadable';
    while (now() < deadline) {
      await sleep(RESUME_MEMORY_POLL_MS, stopping.signal);
      if (stopping.signal.aborted || !isCurrent()) return 'stale';
      const reading = readMemory();
      if (!reading?.pressure) return 'unreadable';
      const countersQuiet = !previous.events || !reading.events
        || (reading.events.high === previous.events.high && reading.events.max === previous.events.max);
      if (countersQuiet && reading.pressure.fullAvg60 < RESUME_MEMORY_CALM_FULL_AVG60) return 'calm';
      previous = reading;
    }
    return 'timeout';
  };

  const leaveToUser = (session: ResumeSession, reason: string) => decide(session.sessionId, session.directory, (metadata) => (
    currentRecord(metadata, session.at)?.resume?.state === 'waiting'
      ? resumePatch({ state: 'manual', at: now(), reason })
      : null
  ));

  const claim = async (session: ResumeSession) => {
    current.set(session.sessionId, session.at);
    const { changed } = await decide(session.sessionId, session.directory, (metadata) => {
      const record = currentRecord(metadata, session.at);
      return isPrioritySession(metadata) && record && !record.resume ? resumePatch({ state: 'waiting', at: now() }) : null;
    });
    return changed;
  };

  const isCurrent = (session: ResumeSession) => current.get(session.sessionId) === session.at;

  const send = async (session: ResumeSession): Promise<ResumeOutcome> => {
    const { sessionId, directory, at } = session;
    const marked = await decide(sessionId, directory, (metadata) => (
      isCurrent(session) && isPrioritySession(metadata) && currentRecord(metadata, at)?.resume?.state === 'waiting'
        ? resumePatch({ state: 'sent', at: now() })
        : null
    ));
    if (!marked.changed) return 'skipped';
    try {
      await sendPrompt({ sessionId, directory, ...resumeMessage(session, 'auto') });
      return 'sent';
    } catch (error) {
      console.warn(`[session-interruption] could not resume ${sessionId} automatically:`, error instanceof Error ? error.message : String(error));
      await decide(sessionId, directory, (metadata) => (
        currentRecord(metadata, at)?.resume?.state === 'sent'
          ? resumePatch({ state: 'manual', at: now(), reason: 'send-failed' })
          : null
      ));
      return 'manual';
    }
  };

  const guarded = async <Result>(session: ResumeSession, step: (session: ResumeSession) => Promise<Result>): Promise<Result | 'skipped'> => {
    try {
      return await step(session);
    } catch (error) {
      console.warn(`[session-interruption] automatic resume of ${session.sessionId} failed:`, error instanceof Error ? error.message : String(error));
      return 'skipped';
    }
  };

  const resume = async (sessions: readonly InterruptedSession[]) => {
    const outcomes: Record<string, ResumeOutcome> = {};
    const claimed: ResumeSession[] = [];
    for (const session of sessions) {
      if (!session.recorded || !session.priority) continue;
      const candidate = { ...session, directory: session.directory ?? '' };
      const won = await guarded(candidate, claim);
      if (won === true) claimed.push(candidate);
      else outcomes[session.sessionId] = 'skipped';
    }
    if (claimed.length === 0) return outcomes;

    if (claimed.some((session) => session.cause === 'memory-pressure')) {
      const memory = await waitForCalmMemory(() => claimed.some(isCurrent));
      if (memory !== 'calm') {
        for (const session of claimed) {
          if (memory === 'stale' || !isCurrent(session)) {
            outcomes[session.sessionId] = 'skipped';
            continue;
          }
          await guarded(session, (item) => leaveToUser(item, memory === 'timeout' ? 'memory-timeout' : 'memory-unreadable'));
          outcomes[session.sessionId] = 'manual';
        }
        return outcomes;
      }
    }

    for (const session of claimed) outcomes[session.sessionId] = await guarded(session, send);
    return outcomes;
  };

  const continueManually = async ({ sessionId, directory = '', at }: ManualContinuation) => {
    const selected: RecordSelection = { record: null };
    const claimed = await decide(sessionId, directory, (metadata) => {
      const current = currentRecord(metadata, at);
      if (!current || current.resume?.state === 'sent') return null;
      selected.record = current;
      return resumePatch({ state: 'sent', at: now() });
    });
    const record = selected.record;
    if (!claimed.changed || !record) return 'conflict';
    try {
      await sendPrompt({ sessionId, directory, ...resumeMessage(record, 'continue') });
    } catch (error) {
      console.warn(`[session-interruption] could not continue ${sessionId}:`, error instanceof Error ? error.message : String(error));
      const previous = record.resume ?? null;
      await decide(sessionId, directory, (metadata) => (
        currentRecord(metadata, at)?.resume?.state === 'sent' ? resumePatch(previous) : null
      ));
      return 'send-failed';
    }
    await decide(sessionId, directory, (metadata) => (
      currentRecord(metadata, at) ? { openchamber: { interruption: null } } : null
    ));
    return 'sent';
  };

  const stop = () => {
    stopping.abort();
    current.clear();
  };

  return { resume, continueManually, stop };
};
