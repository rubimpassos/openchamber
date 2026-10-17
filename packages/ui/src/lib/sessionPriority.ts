import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';

/**
 * A priority session, `session.metadata.openchamber.priority = { at }`. The
 * user switches it on and off; the sidebar lists it above everything else,
 * and the server resumes it on its own after an OpenCode restart cut it off
 * (`packages/web/server/lib/session-interruption/`, which parses the same
 * shape in `priority.js`).
 */
const prioritySchema = z.object({ openchamber: z.object({ priority: z.object({ at: z.number() }) }) });

export function isSessionPriority(session: Session | null | undefined): boolean {
  return prioritySchema.safeParse(session?.metadata).success;
}

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

/** The metadata with the priority mark set (`on`) or removed. */
export function withSessionPriority(metadata: Metadata, on: boolean, now: number): Metadata {
  const isOn = prioritySchema.safeParse(metadata).success;
  if (isOn === on) return metadata;
  const namespace = { ...(openchamberSchema.safeParse(metadata).data?.openchamber ?? {}) };
  if (on) namespace.priority = { at: now };
  else delete namespace.priority;
  return { ...metadata, openchamber: namespace };
}
