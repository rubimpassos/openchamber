import fs from 'node:fs/promises';
import path from 'node:path';
import { fail, hasCode } from './host-inputs.js';
import { readOptionalText } from './host-files.js';
import { FRONT_HOME } from './host-paths.js';

export { FRONT_HOME } from './host-paths.js';
export { fail } from './host-inputs.js';
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
export const ROOT_EQUIVALENT_GROUPS = Object.freeze(['root', 'sudo', 'wheel', 'admin', 'adm', 'docker', 'lxd', 'incus', 'incus-admin', 'libvirt', 'disk', 'shadow', 'kvm']);
const FIRST_REGULAR_UID = 1000;
const SYSTEM_TREES = ['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/root', '/proc', '/sys', '/dev', '/run', '/opt', '/srv', '/var', '/snap'];
const within = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
const privilegedGroups = (account: HostAccount) => (account.groups ?? []).filter((group) => ROOT_EQUIVALENT_GROUPS.includes(group));

export type HostAccount = {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly gids: readonly number[];
  readonly groups?: readonly string[];
  readonly home: string;
  readonly shell: string;
};

type Separation = { readonly frontDoor: string; readonly agent: string; readonly agentPort: number };
type SeparationOptions = {
  readonly existing?: { readonly separation?: Separation | null } | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly owner: string;
  readonly agentUser?: string | undefined;
  readonly agentPort?: number | undefined;
  readonly port: number;
};

export function separationConfig({ existing, enabled, owner, agentUser, agentPort, port }: SeparationOptions) {
  if (existing?.separation && enabled === false) fail('separation_required', 'An existing separated install cannot return to one account');
  if (enabled === false || (existing && enabled !== true && !existing.separation)) return null;
  const value = { ...existing?.separation, frontDoor: 'openchamber', agent: agentUser ?? existing?.separation?.agent ?? `${owner}-agent`, agentPort: agentPort ?? existing?.separation?.agentPort ?? 41890 };
  if (!USER.test(value.agent) || new Set([owner, value.frontDoor, value.agent, 'root']).size !== 4) fail('invalid_accounts', 'The human, front door and agent must be distinct non-root accounts');
  if (existing?.separation && value.agent !== existing.separation.agent) fail('agent_changed', 'The installed agent account cannot be changed');
  if (!Number.isInteger(value.agentPort) || value.agentPort < 1 || value.agentPort > 65535 || value.agentPort === port) fail('invalid_agent_port', 'The agent needs a separate valid port');
  return value;
}

const lookup = async <Account extends HostAccount>(system: { readonly account: (name: string) => Promise<Account> }, name: string) => {
  try { return await system.account(name); }
  catch (error) { if (hasCode(error, 'owner_unknown')) return null; throw error; }
};

type EnsureAccountsOptions<Account extends HostAccount> = {
  readonly system: {
    account(name: string): Promise<Account>;
    run(command: string, args: string[]): Promise<string | void>;
    chown(target: string, uid: number, gid: number): Promise<void>;
  };
  readonly root?: string;
  readonly config: { readonly owner: string; readonly separation?: Separation | null };
  readonly say?: (message: string) => void;
};

export async function ensureAccounts<Account extends HostAccount>({ system, root = '/', config, say = () => {} }: EnsureAccountsOptions<Account>) {
  const human = await system.account(config.owner);
  if (!config.separation) return { human, front: human, agent: human };
  const { frontDoor, agent: agentName } = config.separation;
  let front = await lookup(system, frontDoor);
  if (!front) {
    await system.run('useradd', ['--system', '--home-dir', FRONT_HOME, '--create-home', '--shell', '/usr/sbin/nologin', '--user-group', frontDoor]);
    front = await system.account(frontDoor);
  }
  if (privilegedGroups(front).length) fail('front_account_privileged', `The openchamber account must not be in ${privilegedGroups(front).join(', ')}: remove it from those groups first`);
  if (front.uid === 0 || front.home !== FRONT_HOME || !['/usr/sbin/nologin', '/sbin/nologin', '/bin/false'].includes(front.shell)) fail('front_account_conflict', 'The openchamber account must have its dedicated home and a nologin shell');
  let agent = await lookup(system, agentName);
  if (!agent) {
    await system.run('useradd', ['--create-home', '--shell', '/bin/bash', '--user-group', agentName]);
    agent = await system.account(agentName);
  }
  if (agent.uid === 0 || agent.uid === front.uid || agent.uid === human.uid || front.uid === human.uid || agent.home === human.home || agent.home === front.home || !path.isAbsolute(agent.home) || agent.home === '/') fail('agent_account_conflict', 'The agent needs its own identity and home');
  const home = path.normalize(agent.home);
  if (agent.uid < FIRST_REGULAR_UID || [human.home, FRONT_HOME].some((other) => within(other, home) || within(home, other)) || SYSTEM_TREES.some((tree) => within(tree, home))) {
    fail('agent_account_conflict', `The agent account ${agent.name} must be a regular account whose home is its own (found uid ${agent.uid}, home ${agent.home})`);
  }
  if (privilegedGroups(agent).length) fail('agent_account_privileged', `The agent account ${agent.name} must not be in ${privilegedGroups(agent).join(', ')}: remove it from those groups first`);
  await system.run('usermod', ['--lock', agent.name]);
  for (const account of [front, agent]) {
    const home = path.join(root, account.home);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(home)).isSymbolicLink()) fail('account_home_link', 'An account home cannot be a symbolic link');
    await fs.chmod(home, 0o700);
    await system.chown(home, account.uid, account.gid);
  }
  const ranges = await readOptionalText(path.join(root, '/etc/subuid')) ?? '';
  if (!ranges.split('\n').some((line) => line.startsWith(`${agent.name}:`))) say(`No subordinate UID range for ${agent.name}; rootless Docker is unavailable.`);
  return { human, front, agent };
}
