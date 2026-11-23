import fs from 'node:fs/promises';
import path from 'node:path';
import { readOptionalText } from './host-files.js';

const RANGE = 65536;
const FIRST_RANGE = 100000;

type DockerAccount = { readonly name: string; readonly home: string; readonly uid: number };
type DockerSetup = {
  readonly root?: string;
  readonly system: { run(command: string, args: string[]): Promise<string | void> };
  readonly say?: (message: string) => void;
};
type DockerSetupResult = { readonly status: 'ready' } | { readonly status: 'unavailable'; readonly reason: string };
const hasRange = (text: string | null, name: string) => text?.split('\n').some((line) => line.startsWith(`${name}:`) && Number(line.split(':')[2]) > 0);

async function ensureSubordinateIds({ root, system, account }: {
  readonly root: string; readonly system: DockerSetup['system']; readonly account: Pick<DockerAccount, 'name'>;
}) {
  const ranges = await readOptionalText(path.join(root, '/etc/subuid')) ?? '';
  const gids = await readOptionalText(path.join(root, '/etc/subgid')) ?? '';
  if (hasRange(ranges, account.name) && hasRange(gids, account.name)) return false;
  let end = FIRST_RANGE;
  for (const line of `${ranges}\n${gids}`.split('\n')) {
    const [, start = NaN, count = NaN] = line.split(':').map(Number);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(count) && start + count > end) end = start + count;
  }
  const start = Math.ceil(end / RANGE) * RANGE;
  const span = `${start}-${start + RANGE - 1}`;
  await system.run('usermod', ['--add-subuids', span, '--add-subgids', span, account.name]);
  return true;
}

async function setupRootlessDocker({ root = '/', system, account, say = () => {} }: DockerSetup & { readonly account: DockerAccount }): Promise<DockerSetupResult> {
  const unavailable = (reason: string): DockerSetupResult => { say(`docker for ${account.name}: unavailable (${reason})`); return { status: 'unavailable', reason }; };
  try {
    const ranges = await readOptionalText(path.join(root, '/etc/subuid'));
    const gids = await readOptionalText(path.join(root, '/etc/subgid'));
    if (![ranges, gids].every((text) => hasRange(text, account.name))) return unavailable(`${account.name} has no subordinate IDs`);
    let tool;
    for (const directory of ['/usr/bin', '/usr/local/bin']) {
      const candidate = path.join(directory, 'dockerd-rootless-setuptool.sh');
      if (await fs.access(path.join(root, candidate), fs.constants.X_OK).then(() => true, () => false)) { tool = candidate; break; }
    }
    if (!tool || !await fs.access(path.join(root, '/usr/bin/newuidmap'), fs.constants.X_OK).then(() => true, () => false)) return unavailable('rootless Docker tools are missing');
    await system.run('loginctl', ['enable-linger', account.name]);
    await system.run('runuser', ['-u', account.name, '--', 'env', `HOME=${account.home}`, `XDG_RUNTIME_DIR=/run/user/${account.uid}`, 'PATH=/usr/local/bin:/usr/bin:/bin', tool, 'install']);
    say(`docker for ${account.name}: ready`);
    return { status: 'ready' };
  } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
}

export const setupAgentDocker = ({ agent, ...rest }: DockerSetup & { readonly agent: DockerAccount }) => setupRootlessDocker({ account: agent, ...rest });

export async function setupFrontDoorDocker({ root = '/', system, front, say = () => {} }: DockerSetup & { readonly front: DockerAccount }): Promise<DockerSetupResult> {
  try {
    await ensureSubordinateIds({ root, system, account: front });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    say(`docker for ${front.name}: unavailable (${reason})`);
    return { status: 'unavailable', reason };
  }
  return setupRootlessDocker({ root, system, account: front, say });
}
