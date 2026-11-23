import path from 'node:path';
import { z } from 'zod';
import { isRecord } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../event-stream/contracts.js';

export const text = z.string().max(200_000);
export const id = z.string().min(1).max(256);
export const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const time = z.number().finite();
export const directory = z.string().min(1).max(4096).refine((value) => {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return !value.includes('\0') && !/^\/spaces(?:\/|$)/i.test(normalized);
});

type WithoutProvenance<Value> = Value extends readonly (infer Entry)[] ? WithoutProvenance<Entry>[]
  : Value extends object ? {
    [Key in keyof Value as Key extends 'spaceId' | 'origin' ? never : Key]: WithoutProvenance<Value[Key]>;
  } & {
    [Key in keyof Value as Key extends 'origin' ? Key : never]?: WithoutProvenance<Extract<Value[Key], object | null>>;
  }
  : Value;

export function stripProvenance<Value extends JsonObject>(value: Value): WithoutProvenance<Value>;
export function stripProvenance(value: JsonValue): JsonValue;
export function stripProvenance(value: JsonValue | undefined): JsonValue | undefined;
export function stripProvenance(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) return value.map((entry) => stripProvenance(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => key !== 'spaceId' && (key !== 'origin' || entry === null || isRecord(entry) || Array.isArray(entry)))
    .map(([key, entry]) => [key, stripProvenance(entry)]));
}
