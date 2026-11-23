export class HostInstallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new HostInstallError(code, message);
}

export function hasCode(error: unknown, code: string): error is { readonly code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };
