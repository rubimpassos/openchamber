export const runtimeError = (code: string, status = 409) => Object.assign(new Error(code), { code, status });
