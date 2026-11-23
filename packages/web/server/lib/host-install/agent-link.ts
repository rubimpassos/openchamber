import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { fail } from './host-inputs.js';
import { readOptionalText, writeRootFile } from './host-files.js';
import type { RootFileSystem } from './host-files.js';
import type { HostPaths } from './host-paths.js';

export async function writeAgentLink({ system, paths, config, rotate = false }: {
  readonly system: RootFileSystem;
  readonly paths: Pick<HostPaths, 'agentEnv' | 'agentLink'>;
  readonly config: { readonly separation: { readonly agentPort: number } };
  readonly rotate?: boolean;
}): Promise<void> {
  const link = await readOptionalText(paths.agentLink);
  const agent = await readOptionalText(paths.agentEnv);
  const old = /^OPENCHAMBER_AGENT_SERVER_TOKEN=([A-Za-z0-9_-]{43})$/m.exec(link ?? '')?.[1];
  if (!rotate && (link || agent) && (!old || !agent?.includes(`OPENCHAMBER_UI_PASSWORD=${old}\n`))) fail('agent_token_invalid', 'The agent env files disagree; repair them with rotate-agent-token');
  const token = rotate || !old ? randomBytes(32).toString('base64url') : old;
  try {
    await writeRootFile(system, paths.agentEnv, `OPENCHAMBER_UI_PASSWORD=${token}\nOPENCHAMBER_AGENT_SERVER=1\nOPENCHAMBER_RELAY_HOST=off\n`, 0o600);
    await writeRootFile(system, paths.agentLink, `OPENCHAMBER_AGENT_SERVER_URL=http://127.0.0.1:${config.separation.agentPort}\nOPENCHAMBER_AGENT_SERVER_TOKEN=${token}\nOPENCHAMBER_DATA_DIR=/var/lib/openchamber/.config/openchamber\n`, 0o600);
  } catch (error) {
    if (agent !== null) await writeRootFile(system, paths.agentEnv, agent, 0o600);
    else await fs.rm(paths.agentEnv, { force: true });
    if (link !== null) await writeRootFile(system, paths.agentLink, link, 0o600);
    else await fs.rm(paths.agentLink, { force: true });
    throw error;
  }
}
