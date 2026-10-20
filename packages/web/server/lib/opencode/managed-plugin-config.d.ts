/** Append and deduplicate a managed plugin directory in inherited JSONC config. */
export function appendManagedPlugin(
  rawConfig: string | undefined,
  pluginDirectory: string,
  purpose: string,
): string;
