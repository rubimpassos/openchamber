import type { JsonObject } from './host-inputs.js';
import { readOptionalText } from './host-files.js';

type HostSeparation = JsonObject & {
  readonly frontDoor: string; readonly agent: string; readonly agentPort: number;
  docker?: boolean; frontDocker?: boolean;
};
export type HostConfig = JsonObject & {
  readonly owner: string; readonly repo: string; readonly port: number; readonly host: string;
  readonly separation?: HostSeparation | null;
};

export async function readHostConfig(file: string): Promise<HostConfig | null> {
  const text = await readOptionalText(file);
  return text === null ? null : JSON.parse(text);
}
