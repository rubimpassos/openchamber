export const requireLocalRuntime = <Runtime>(runtime: Runtime | null | undefined, name: string): Runtime => {
  if (runtime === null || runtime === undefined) throw new TypeError(`${name} is unavailable in this server mode`);
  return runtime;
};
