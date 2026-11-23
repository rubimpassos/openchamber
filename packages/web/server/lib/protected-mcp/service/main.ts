import fs from 'node:fs/promises';
import path from 'node:path';
import { parseServiceConfig } from './config.js';
import { createIntegrity, resolveIdentity } from './integrity.js';
import { runPreflight } from './preflight.js';
import { createProtectedMcpService } from './service.js';
import { isRecord } from '../../shared/guards.js';

const log = (event: string, fields: Readonly<object> = {}) => { process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`); };

async function main(argv: readonly string[]) {
  const index = argv.indexOf('--config');
  const file = argv[index + 1];
  if (index === -1 || !file) {
    process.stderr.write('Usage: main.js --config <service.json>\n');
    return 64;
  }
  const config = parseServiceConfig(JSON.parse(await fs.readFile(file, 'utf8')));
  const engine = await resolveIdentity(config.engineUser);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('The protected MCP service requires a Unix account');
  const integrityOptions = { owners: [0, uid], groups: [0], engine };
  const integrity = createIntegrity(integrityOptions);
  const socketDirectory = path.dirname(config.engineSocket);
  if (config.engineSocketGroup !== null) {
    await fs.chown(socketDirectory, -1, config.engineSocketGroup);
    await fs.chmod(socketDirectory, 0o750);
  }
  const adminDirectory = path.dirname(config.adminSocket);
  if (config.adminSocketGroup !== null) await fs.chown(adminDirectory, -1, config.adminSocketGroup);
  await fs.chmod(adminDirectory, 0o750);
  const current = await fs.realpath(path.join(config.installDir, 'current'));
  const service = await createProtectedMcpService({
    version: config.serviceVersion,
    stateDir: config.stateDir,
    engineSocketPath: config.engineSocket,
    subjectsDir: config.subjectsDir,
    engineSocketGroup: config.engineSocketGroup,
    adminSocketPath: config.adminSocket,
    adminSocketGroup: config.adminSocketGroup,
    integrity: integrityOptions,
    workerPath: config.workerPath,
    npmCommand: config.npm,
    enforcement: () => runPreflight({
      integrity,
      engine,
      engineUser: config.engineUser,
      engineUnit: config.engineUnit,
      adminSocket: config.adminSocket,
      trustedPaths: [config.node, ...(config.npm ?? []), ...config.workerPath.split(':'), config.stateDir, config.subjectsDir, socketDirectory, adminDirectory],
      trustedTrees: [current, config.configDir],
      privateDirectories: [config.stateDir, config.subjectsDir],
    }),
    log,
  });
  await service.start();
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => resolve());
  });
  await service.close();
  return 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error) => {
  const failure = isRecord(error) ? error : {};
  log('service_failed', { code: failure['code'] ?? failure['name'] ?? 'Error' });
  process.exitCode = 1;
});
