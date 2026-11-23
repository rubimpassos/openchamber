import fs from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { install, rollback, status, uninstall, update } from './host.js';
import { ROOT_COMMANDS, rootCommand } from './root-commands.js';
import { askNewPassword } from './tty-password.js';
import { isRecord } from './host-inputs.js';

type Commands = {
  readonly install: typeof install; readonly update: typeof update; readonly rollback: typeof rollback;
  readonly uninstall: typeof uninstall; readonly status: typeof status; readonly rootCommand: typeof rootCommand;
};
type CliOptions = {
  readonly out?: Writable; readonly err?: Writable; readonly input?: Readable;
  readonly askPassword?: typeof askNewPassword;
  readonly commands?: Commands;
};

const USAGE = `Usage: main.js <command> [options]

Commands (as root, except status):
  install      Install or reinstall OpenChamber for an account, with its units
  update       Install the newest release when it is newer than the running one
  rollback     Run the previous version again
  uninstall    Remove it; the env file and protected MCP credentials stay unless --purge
  status       Show what is installed and running
  approve-root-passkey, root-passkeys, revoke-root-passkey <id>
  share-project <path>, unshare-project <path>, repair-permissions
  backup-prepare --into <dir>, rotate-agent-token, setup-agent-docker, setup-front-docker

Options for install (left out: the value from the earlier install):
  --owner <account>        Human account that owns the projects
  --separation            Enable separate front-door and agent accounts
  --no-separation         Keep one account on a fresh install
  --agent-user <account>  Agent account (default <owner>-agent)
  --agent-port <port>      Agent loopback port (default 41890)
  --dry-run               Print migration without changing the host
  --bot-worktrees-file <file> Root-reviewed read-only retained Bot path mapping
  --repo <owner/name>      GitHub repository whose releases are installed
  --port <port>            Port OpenChamber listens on (default 3000)
  --host <address>         Address it listens on (default 127.0.0.1)
  --no-auto-update         Do not check for updates daily
  --no-protected-mcp       Do not install the protected MCP service
  --accept-unprotected     Install the protected MCP service even when the owner can reach root
  --tarball <file>         Install this verified package instead of downloading (with --version)
  --version <version>      Version of --tarball
  --ui-password-stdin      Read a new UI password from stdin; without it, a terminal asks for one
                           when OpenChamber has none (never with curl | bash, whose stdin is the script)

Common options:
  --json                   Print the result as JSON
  --quiet                  Print compact results without progress
  --confirm <fingerprint>  Confirm a proved, waiting root passkey without a TTY
  --purge --purge-accounts Remove the separate accounts and their homes
`;

function parse(argv: readonly string[]) {
  const [command, ...rest] = argv;
  const options: Partial<Record<string, string>> = {};
  const flags = new Set<string>();
  let argument: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) break;
    if (!arg.startsWith('--')) {
      if (argument || !command || !['share-project', 'unshare-project', 'revoke-root-passkey'].includes(command)) throw Object.assign(new Error(`Unexpected argument ${arg}`), { code: 'usage' });
      argument = arg;
      continue;
    }
    const name = arg.slice(2);
    if (['json', 'quiet', 'separation', 'no-separation', 'dry-run', 'purge-accounts', 'no-auto-update', 'no-protected-mcp', 'accept-unprotected', 'purge', 'help', 'ui-password-stdin'].includes(name)) {
      flags.add(name);
      continue;
    }
    const value = rest[index + 1];
    if (!['owner', 'repo', 'port', 'host', 'tarball', 'version', 'agent-user', 'agent-port', 'into', 'confirm', 'bot-worktrees-file'].includes(name) || value === undefined || value.startsWith('--')) {
      throw Object.assign(new Error(`Unknown option ${arg}`), { code: 'usage' });
    }
    options[name] = value;
    index += 1;
  }
  if (flags.has('separation') && flags.has('no-separation')) throw Object.assign(new Error('Choose --separation or --no-separation'), { code: 'usage' });
  if (command && ['share-project', 'unshare-project', 'revoke-root-passkey'].includes(command) && !argument) throw Object.assign(new Error('A path or passkey ID is required'), { code: 'usage' });
  return { command, options, flags, argument };
}

const readAll = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

export async function cli(argv: readonly string[], { out = process.stdout, err = process.stderr, input = process.stdin, askPassword = askNewPassword, commands = { install, update, rollback, uninstall, status, rootCommand } }: CliOptions = {}) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    const message = isRecord(error) ? error['message'] : undefined;
    if (argv.includes('--json')) out.write(`${JSON.stringify({ ok: false, code: 'usage', error: message })}\n`);
    else err.write(`${message}\n\n${USAGE}`);
    return 64;
  }
  const { command, options, flags, argument } = parsed;
  if (!command || command === '--help' || flags.has('help')) {
    out.write(USAGE);
    return 0;
  }
  const json = flags.has('json');
  const say = json || flags.has('quiet') ? () => {} : (text: string) => { out.write(`${text}\n`); };
  const operations = {
    install: () => commands.install({
      say,
      owner: options.owner,
      repo: options.repo,
      port: options.port === undefined ? undefined : Number(options.port),
      host: options.host,
      autoUpdate: flags.has('no-auto-update') ? false : undefined,
      protectedMcp: flags.has('no-protected-mcp') ? false : undefined,
      acceptUnprotected: flags.has('accept-unprotected') ? true : undefined,
      tarball: options.tarball ?? null,
      version: options.version ?? null,
      separation: flags.has('separation') ? true : flags.has('no-separation') ? false : undefined,
      agentUser: options['agent-user'],
      agentPort: options['agent-port'] === undefined ? undefined : Number(options['agent-port']),
      dryRun: flags.has('dry-run'),
      botWorktreesFile: options['bot-worktrees-file'],
      readUiPassword: async () => {
        if (flags.has('ui-password-stdin')) return readAll(input);
        return json || flags.has('quiet') ? null : askPassword();
      },
    }),
    update: () => commands.update({ say, tarball: options.tarball ?? null, version: options.version ?? null }),
    rollback: () => commands.rollback({ say }),
    uninstall: () => commands.uninstall({ say, purge: flags.has('purge'), purgeAccounts: flags.has('purge-accounts') }),
    status: () => commands.status({}),
  };
  const run = command in operations ? Object.entries(operations).find(([name]) => name === command)?.[1] : ROOT_COMMANDS.includes(command) ? async () => {
    if (command === 'approve-root-passkey' && !options.confirm && (json || flags.has('quiet'))) throw Object.assign(new Error('Use --confirm <fingerprint> in JSON or quiet mode'), { code: 'confirmation_required' });
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Approval cancelled'));
    process.once('SIGINT', cancel);
    try { return await commands.rootCommand(command, { say, argument, into: options.into, confirm: options.confirm, input, output: out, signal: controller.signal }); }
    finally { process.off('SIGINT', cancel); }
  } : null;
  if (!run) {
    if (json) out.write(`${JSON.stringify({ ok: false, code: 'usage', error: `Unknown command ${command}` })}\n`);
    else err.write(`Unknown command ${command}\n\n${USAGE}`);
    return 64;
  }
  try {
    if (command === 'status') {
      const result = await commands.status({});
      if (json) out.write(`${JSON.stringify({ ok: true, ...result })}\n`);
      else out.write(formatStatus(result));
      return 0;
    }
    const result = await run();
    if (json) out.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    else if (ROOT_COMMANDS.includes(command) || flags.has('quiet')) out.write(`${JSON.stringify(result)}\n`);
    const protectedMcp = isRecord(result) && 'protectedMcp' in result ? result.protectedMcp : undefined;
    return isRecord(protectedMcp) && protectedMcp['status'] === 'failed' ? 2 : 0;
  } catch (error) {
    const fields = isRecord(error) ? error : {};
    if (json) out.write(`${JSON.stringify({ ok: false, code: fields['code'] ?? 'failed', error: fields['message'] })}\n`);
    else err.write(`error: ${fields['message']}\n`);
    return fields['code'] === 'root_required' ? 77 : 1;
  }
}

function formatStatus(result: Awaited<ReturnType<typeof status>>) {
  if (!result.installed || !('config' in result)) return 'OpenChamber is not installed on this host.\n';
  const { config, current, previous, units } = result;
  if (!config || !units) throw new TypeError('Installed host status is incomplete');
  return [
    `version     ${current ?? 'none'}${previous ? ` (previous ${previous})` : ''}`,
    `owner       ${config.owner}`,
    `repository  ${config.repo}`,
    `listen      ${config.host}:${config.port}`,
    `auto update ${config.autoUpdate ? 'daily' : 'off'}`,
    `protected   ${config.protectedMcp ? 'on' : 'off'}`,
    ...Object.entries(units).map(([name, state]) => `${name.padEnd(30)} ${state}`),
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await fs.realpath(process.argv[1])) {
  process.umask(0o022);
  process.exitCode = await cli(process.argv.slice(2));
}
