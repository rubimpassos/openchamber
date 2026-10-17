/**
 * `metadata.openchamber.priority = { at }`: the user marked the session as a
 * priority. The UI sets and clears it through the metadata route
 * (`setSessionPriority` in `packages/ui/src/sync/session-actions.ts`); the
 * UI parser is `packages/ui/src/lib/sessionPriority.ts`.
 */
import { z } from 'zod';

const prioritySchema = z.object({ openchamber: z.object({ priority: z.object({ at: z.number() }) }) });

export const isPrioritySession = (metadata) => prioritySchema.safeParse(metadata).success;
