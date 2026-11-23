import path from 'node:path';
import { isNumber, isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';
import type { JsonValue } from '../../shared/json-values.js';

const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}\$?$/;
const absolute = (value: JsonValue | undefined, field: string): string => {
  if (!isString(value) || !path.isAbsolute(value) || path.normalize(value) !== value) throw new ProtectedMcpError('invalid_config', { message: `invalid_config: ${field}` });
  return value;
};

export function parseServiceConfig(value: JsonValue | undefined) {
  if (!isPlainObject(value) || value.version !== 1) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: version' });
  if (!isString(value.engineUser) || !ACCOUNT.test(value.engineUser)) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: engineUser' });
  const adminSocketGroup = value.adminSocketGroup ?? null;
  if (adminSocketGroup !== null && (!isNumber(adminSocketGroup) || !Number.isSafeInteger(adminSocketGroup))) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: adminSocketGroup' });
  const npm = value.npm ?? null;
  if (npm !== null && (!Array.isArray(npm) || npm.length === 0)) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: npm' });
  const workerPath = value.workerPath ?? '/usr/local/bin:/usr/bin:/bin';
  if (!isString(workerPath) || !workerPath.split(':').every((entry) => path.isAbsolute(entry))) throw new ProtectedMcpError('invalid_config', { message: 'invalid_config: workerPath' });
  return {
    serviceVersion: isString(value.serviceVersion) ? value.serviceVersion : 'unknown',
    stateDir: absolute(value.stateDir, 'stateDir'),
    engineSocket: absolute(value.engineSocket, 'engineSocket'),
    subjectsDir: absolute(value.subjectsDir ?? '/run/openchamber-protected-mcp/subjects', 'subjectsDir'),
    engineSocketGroup: isNumber(value.engineSocketGroup) && Number.isSafeInteger(value.engineSocketGroup) ? value.engineSocketGroup : null,
    adminSocket: absolute(value.adminSocket ?? '/run/openchamber-protected-mcp-admin/admin.sock', 'adminSocket'),
    adminSocketGroup,
    engineUser: value.engineUser,
    engineUnit: isString(value.engineUnit) ? value.engineUnit : null,
    workerPath,
    node: absolute(value.node, 'node'),
    npm: npm === null ? null : [absolute(npm[0], 'npm.0'), ...npm.slice(1).map((part: JsonValue, index) => absolute(part, `npm.${index + 1}`))] as const,
    installDir: absolute(value.installDir, 'installDir'),
    configDir: absolute(value.configDir, 'configDir'),
  };
}
