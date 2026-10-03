#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hashIntegrationToken } from '../server/lib/integration-control/auth.js';
import { validateIntegrationPolicy } from '../server/lib/integration-control/policy.js';

const existingFile = async (file) => {
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error('Invalid destination');
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const canonicalDestination = async (file) => join(await realpath(dirname(resolve(file))), basename(file));

// Reserve a new destination exclusively before rename: a concurrent creator
// must never be overwritten without --force. Policy readers fail closed during
// first creation; replacements always expose either the old or new full JSON.
const atomicWrite = async (file, contents, mode, force) => {
  const previous = await existingFile(file);
  if (previous && !force) throw new Error('Destination exists');
  const temporary = join(dirname(file), `.integration-${randomBytes(16).toString('hex')}.tmp`);
  let reserved = false;
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      if (previous) await handle.chown(previous.uid, previous.gid);
      await handle.chmod(mode);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!force) {
      const reservation = await open(file, 'wx', mode);
      reserved = true;
      await reservation.close();
    }
    await rename(temporary, file);
    reserved = false;
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (reserved) await unlink(file);
  }
};

// Offline only. Flags never accept a token; secret material goes only to output.
// Existing policy/output replacement requires --force, including revocation.
export const runIntegrationCredentials = async (args) => {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    policy: { type: 'string' }, output: { type: 'string' }, id: { type: 'string' },
    domain: { type: 'string' }, project: { type: 'string', multiple: true },
    action: { type: 'string', multiple: true }, 'expires-at': { type: 'string' },
    force: { type: 'boolean', default: false }, revoke: { type: 'boolean', default: false },
  } });
  if (!values.policy || !values.id) throw new Error('Missing required arguments');
  if (!values.revoke && (!values.output || !values.domain || !values['expires-at']
    || !values.project?.length || !values.action?.length)) throw new Error('Missing issue arguments');
  if (values.revoke && values.output) throw new Error('Revocation does not emit a token');
  const policyFile = await canonicalDestination(values.policy);
  const output = values.output ? await canonicalDestination(values.output) : null;
  const lockPath = `${policyFile}.lock`;
  if (output === policyFile || output === lockPath) throw new Error('Destinations must differ');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const exists = await existingFile(policyFile);
    if (exists && !values.force) throw new Error('Policy replacement requires --force');
    if (output && await existingFile(output) && !values.force) throw new Error('Output exists');
    const parsed = validateIntegrationPolicy(exists
      ? JSON.parse(await readFile(policyFile, 'utf8'))
      : { schemaVersion: 1, domainId: values.domain, credentials: [] });
    if (!parsed.success) throw new Error('Invalid policy');
    const policy = parsed.data;
    if (values.revoke) {
      if (!exists || !policy.credentials.some((entry) => entry.id === values.id)) throw new Error('Unknown credential');
      policy.credentials = policy.credentials.filter((entry) => entry.id !== values.id);
    } else {
      if (policy.domainId !== values.domain) throw new Error('Domain mismatch');
      const token = `oc_integration_${randomBytes(32).toString('base64url')}`;
      const record = {
        id: values.id, domain: values.domain, tokenHash: hashIntegrationToken(token),
        projectIds: values.project, actions: values.action, expiresAt: values['expires-at'], enabled: true,
      };
      policy.credentials = [...policy.credentials.filter((entry) => entry.id !== values.id), record];
      if (!validateIntegrationPolicy(policy).success || Date.parse(record.expiresAt) <= Date.now()) {
        throw new Error('Invalid credential');
      }
      // Publish the secret first: a policy-write failure leaves only an inactive
      // output token, never an active credential whose secret was not delivered.
      await atomicWrite(output, `${token}\n`, 0o600, values.force);
    }
    await atomicWrite(policyFile, `${JSON.stringify(policy, null, 2)}\n`, 0o640, values.force);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runIntegrationCredentials(process.argv.slice(2)).then(() => {
    process.stdout.write('Integration credentials updated.\n');
  }).catch(() => {
    // Never print exception messages: parseArgs/fs errors can contain user input.
    process.stderr.write('Integration credential operation failed. Check arguments, policy and destinations; existing files require --force.\n');
    process.exitCode = 1;
  });
}
