#!/usr/bin/env node
// Command line of the host installer and of the root updater unit.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { install, rollback, status, uninstall, update } from './host.js';

const USAGE = `Usage: main.js <command> [options]

Commands (as root, except status):
  install      Install or reinstall OpenChamber for an account, with its units
  update       Install the newest release when it is newer than the running one
  rollback     Run the previous version again
  uninstall    Remove it; the env file and protected MCP credentials stay unless --purge
  status       Show what is installed and running

Options for install (left out: the value from the earlier install):
  --owner <account>        Account OpenChamber and its agents run as
  --repo <owner/name>      GitHub repository whose releases are installed
  --port <port>            Port OpenChamber listens on (default 3000)
  --host <address>         Address it listens on (default 127.0.0.1)
  --no-auto-update         Do not check for updates daily
  --no-protected-mcp       Do not install the protected MCP service
  --accept-unprotected     Install the protected MCP service even when the owner can reach root
  --tarball <file>         Install this verified package instead of downloading (with --version)
  --version <version>      Version of --tarball

Common options:
  --json                   Print the result as JSON
`;

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const flags = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) throw Object.assign(new Error(`Unexpected argument ${arg}`), { code: 'usage' });
    const name = arg.slice(2);
    if (['json', 'no-auto-update', 'no-protected-mcp', 'accept-unprotected', 'purge', 'help'].includes(name)) {
      flags.add(name);
      continue;
    }
    if (!['owner', 'repo', 'port', 'host', 'tarball', 'version'].includes(name) || rest[index + 1] === undefined) {
      throw Object.assign(new Error(`Unknown option ${arg}`), { code: 'usage' });
    }
    options[name] = rest[index + 1];
    index += 1;
  }
  return { command, options, flags };
}

export async function cli(argv, { out = process.stdout, err = process.stderr, commands = { install, update, rollback, uninstall, status } } = {}) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    err.write(`${error.message}\n\n${USAGE}`);
    return 64;
  }
  const { command, options, flags } = parsed;
  if (!command || command === '--help' || flags.has('help')) {
    out.write(USAGE);
    return 0;
  }
  const json = flags.has('json');
  const say = json ? () => {} : (text) => out.write(`${text}\n`);
  const run = {
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
    }),
    update: () => commands.update({ say, tarball: options.tarball ?? null, version: options.version ?? null }),
    rollback: () => commands.rollback({ say }),
    uninstall: () => commands.uninstall({ say, purge: flags.has('purge') }),
    status: () => commands.status({}),
  }[command];
  if (!run) {
    err.write(`Unknown command ${command}\n\n${USAGE}`);
    return 64;
  }
  try {
    const result = await run();
    if (json) out.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    else if (command === 'status') out.write(formatStatus(result));
    return result?.protectedMcp?.status === 'failed' ? 2 : 0;
  } catch (error) {
    if (json) out.write(`${JSON.stringify({ ok: false, code: error.code ?? 'failed', error: error.message })}\n`);
    else err.write(`error: ${error.message}\n`);
    return error.code === 'root_required' ? 77 : 1;
  }
}

function formatStatus(result) {
  if (!result.installed) return 'OpenChamber is not installed on this host.\n';
  const { config, current, previous, units } = result;
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
  process.exitCode = await cli(process.argv.slice(2));
}
