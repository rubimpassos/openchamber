import { z } from 'zod';
import { SpaceError } from '../spaces/errors.js';

// hostd's `{ ok: false, code, message, details? }`, read from the socket.
const UNREADABLE = { code: 'hostd_answer_unreadable', message: 'hostd returned an invalid error', details: undefined };
const remoteErrorSchema = z.object({
  code: z.string().catch(UNREADABLE.code),
  message: z.string().catch(UNREADABLE.message),
  details: z.unknown(),
}).catch(UNREADABLE);

export const remoteError = (answer: unknown): SpaceError<unknown> => {
  const { code, message, details } = remoteErrorSchema.parse(answer);
  return new SpaceError(code, message, details);
};
export const connectionError = (error: NodeJS.ErrnoException): SpaceError => new SpaceError(
  error.code === 'ENOENT' ? 'hostd_missing' : 'hostd_unreachable',
  error.code === 'ENOENT' ? 'Install and enable the OpenChamber host daemon' : `The OpenChamber host daemon could not be reached (${error.code ?? 'connection failed'})`,
);
