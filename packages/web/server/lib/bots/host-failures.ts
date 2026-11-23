import { z } from 'zod';

export const failureCode = z.object({ code: z.string().optional() })
  .transform((error) => error.code?.startsWith('BOT_') ? error.code : 'BOT_HOST_OPERATION_FAILED')
  .catch('BOT_HOST_OPERATION_FAILED');
export const discoveryPending = z.object({ code: z.literal('BOT_DISCOVERY_PENDING'), pending: z.json() });
