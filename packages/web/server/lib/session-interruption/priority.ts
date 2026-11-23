import { z } from 'zod';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';

const prioritySchema = z.object({ openchamber: z.object({ priority: z.object({ at: z.number() }) }) });

export const isPrioritySession = (metadata: SessionMetadata | undefined): boolean => prioritySchema.safeParse(metadata).success;
