import { isRecord } from '../shared/object-guards.js';

// Dependencies may throw plain provider/transport records as well as Error objects.
export const errorField = (error: unknown, key: string) => isRecord(error) ? error[key] : undefined;
export const errorMessage = (error: unknown) => errorField(error, 'message');
export const errorCode = (error: unknown) => errorField(error, 'code');
export const errorStatus = (error: unknown) => {
  const value = errorField(error, 'status') ?? errorField(error, 'statusCode');
  return typeof value === 'number' ? value : undefined;
};
