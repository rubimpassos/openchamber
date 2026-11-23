import { SpaceError } from './errors.js';

export const isSpaceId = (value: string) => /^[0-9a-f]{12}$/.test(value);
export const isToolsKey = (value: string | null | undefined) => /^[0-9a-f]{16}$/.test(value ?? '');

export function requireSpaceId(value: string) {
  if (!isSpaceId(value)) throw new SpaceError('invalid_space_id', 'A space id is 12 lowercase hex characters');
  return value;
}

export function requireToolsKey(value: string) {
  if (!isToolsKey(value)) throw new SpaceError('invalid_tools_key', 'A tools key is 16 lowercase hex characters');
  return value;
}
