/**
 * Resumes a priority session that a managed OpenCode restart cut off, by
 * sending the agent one message. Ordinary sessions only get the notice and
 * Continue. See DOCUMENTATION.md, "Automatic resume".
 *
 * The progress lives on the restart record itself,
 * `metadata.openchamber.interruption.resume`:
 * `{ state: 'waiting' | 'sent' | 'manual', at, reason? }`. Every step is
 * decided inside the metadata store's write queue against the record as it is
 * then, so:
 *
 * - a record is claimed (`waiting`) once, and marked `sent` before the
 *   message goes out: one interruption sends at most one message, even if
 *   this server restarts in between;
 * - a message the user sent or a Dismiss (both delete the record), a newer
 *   restart (a new `at`) or the priority being switched off stop the resume
 *   before anything is sent.
 */
import { z } from 'zod';
import { isPrioritySession } from './priority.js';
import { RESTART_REASON } from './restart.js';

/**
 * After a `memory-pressure` restart the message waits until the cgroup is
 * calm: `full avg60` under this (percent of the last minute with every task
 * stalled on memory) and the `high`/`max` counters unchanged since the
 * previous read. Lower than the threshold that blamed memory for the restart,
 * so a machine still near it does not get a new turn on top.
 */
const RESUME_MEMORY_CALM_FULL_AVG60 = 2;
/** How often the cgroup is read while waiting. */
export const RESUME_MEMORY_POLL_MS = 15_000;
/** Past this, the resume is left to the user (`state: 'manual'`). */
export const RESUME_MEMORY_DEADLINE_MS = 10 * 60_000;

const restartRecordSchema = z.object({
  openchamber: z.object({
    interruption: z.object({
      reason: z.literal(RESTART_REASON),
      at: z.number(),
      cause: z.string().nullish().catch(null),
      tool: z.object({ name: z.string().min(1), input: z.string().nullish() }).nullish().catch(null),
      // Loose: a failed Continue puts the whole previous state back.
      resume: z.looseObject({ state: z.enum(['waiting', 'sent', 'manual']) }).nullish(),
    }),
  }),
});

const resumePatch = (resume) => ({ openchamber: { interruption: { resume } } });

/** The restart record written at `at`, when it is still the session's current one. */
const currentRecord = (metadata, at) => {
  const interruption = restartRecordSchema.safeParse(metadata).data?.openchamber.interruption;
  return interruption?.at === at ? interruption : null;
};

const CAUSE_TEXT = {
  'memory-pressure': 'the server ran out of memory',
  'health-timeout': 'OpenCode stopped responding',
  'process-exited': 'the OpenCode process stopped',
};

/**
 * The message the agent receives, from the automatic resume and from the
 * notice's Continue alike. English, like the server's other agent-facing text.
 */
export const buildResumeMessage = ({ at, cause, tool }) => {
  const when = new Date(at).toISOString();
  const why = CAUSE_TEXT[cause] ? ` because ${CAUSE_TEXT[cause]}` : '';
  const what = tool ? ` while \`${tool.input || tool.name}\` was running` : '';
  return [
    `OpenChamber resumed this session. OpenCode restarted at ${when}${why} and cut off your last turn${what}.`,
    'Before repeating that or any other command, check the current state: files you changed and processes you started that may still be running.',
    'Then continue from where you stopped, without redoing steps that already took effect.',
  ].join(' ');
};

/**
 * The resume travels as a synthetic message whose metadata names it, so the
 * transcript shows an OpenChamber row rather than a user message. The UI
 * parser is `packages/ui/src/lib/opencode/openchamber-resume.ts`.
 */
const RESUME_MESSAGE_SOURCE = 'openchamber-notice';

const resumeTool = (tool) => {
  if (!tool) return null;
  const summary = { name: tool.name };
  if (tool.input) summary.input = tool.input;
  return summary;
};

const resumeMessage = ({ at, cause, tool }, trigger) => ({
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

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {object} options
 * @param {(sessionID: string, decide: (metadata: object) => object | null, options: { directory: string }) => Promise<{ changed: boolean }>} options.updateMetadata
 * @param {(input: { sessionId: string, directory: string, text: string, description: string, metadata: object }) => Promise<unknown>} options.sendPrompt
 *   Admits the message as a synthetic one that wakes the session.
 * @param {() => ({ events: { high: number, max: number } | null, pressure: { fullAvg60: number } | null } | null)} options.readMemory
 */
export const createAutoResumeRuntime = ({
  updateMetadata,
  sendPrompt,
  readMemory,
  now = Date.now,
  sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }),
}) => {
  const stopping = new AbortController();
  // The newest restart each session is being resumed for; an older wait ends.
  const current = new Map();

  const decide = (sessionId, directory, step) => updateMetadata(sessionId, step, { directory });

  /** `calm`, `timeout` or `unreadable`. */
  const waitForCalmMemory = async (isCurrent) => {
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

  const leaveToUser = (session, reason) => decide(session.sessionId, session.directory, (metadata) => (
    currentRecord(metadata, session.at)?.resume?.state === 'waiting'
      ? resumePatch({ state: 'manual', at: now(), reason })
      : null
  ));

  const claim = async (session) => {
    current.set(session.sessionId, session.at);
    const { changed } = await decide(session.sessionId, session.directory, (metadata) => {
      const record = currentRecord(metadata, session.at);
      return isPrioritySession(metadata) && record && !record.resume ? resumePatch({ state: 'waiting', at: now() }) : null;
    });
    return changed;
  };

  const isCurrent = (session) => current.get(session.sessionId) === session.at;

  const send = async (session) => {
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
      console.warn(`[session-interruption] could not resume ${sessionId} automatically:`, errorMessage(error));
      await decide(sessionId, directory, (metadata) => (
        currentRecord(metadata, at)?.resume?.state === 'sent'
          ? resumePatch({ state: 'manual', at: now(), reason: 'send-failed' })
          : null
      ));
      return 'manual';
    }
  };

  /** Runs one step for a session; a failure stays with that session. */
  const guarded = async (session, step) => {
    try {
      return await step(session);
    } catch (error) {
      console.warn(`[session-interruption] automatic resume of ${session.sessionId} failed:`, errorMessage(error));
      return 'skipped';
    }
  };

  /**
   * Resumes the priority sessions among those `recordRestartInterruptions`
   * answered for one restart. Every session is claimed first; after a
   * `memory-pressure` restart the wait for calm memory happens once for all
   * of them; then the messages go out one after another. Resolves
   * `{ [sessionId]: 'sent' | 'manual' | 'skipped' }`.
   */
  const resume = async (sessions) => {
    const outcomes = {};
    const claimed = [];
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

  /**
   * The notice's Continue: sends the same message for the restart written at
   * `at` and deletes the record, the way a message the user sends does.
   * Taking it over from an automatic resume still waiting is allowed (the user
   * wins; the automatic step then finds `sent` and skips). Resolves
   * `'sent'`, `'conflict'` when the record is gone, newer, or already resumed,
   * or `'send-failed'`, which puts the previous resume state back.
   */
  const continueManually = async ({ sessionId, directory = '', at }) => {
    let record = null;
    const claimed = await decide(sessionId, directory, (metadata) => {
      const current = currentRecord(metadata, at);
      if (!current || current.resume?.state === 'sent') return null;
      record = current;
      return resumePatch({ state: 'sent', at: now() });
    });
    if (!claimed.changed || !record) return 'conflict';
    try {
      await sendPrompt({ sessionId, directory, ...resumeMessage(record, 'continue') });
    } catch (error) {
      console.warn(`[session-interruption] could not continue ${sessionId}:`, errorMessage(error));
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
