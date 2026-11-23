import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { registeredTransferDirectory, registeredTransferProject } from './registered-transfer-project.js';
import { registeredTransferDirectory as legacyDirectory } from './space-transfer-routes.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

test('returns the registered project identity when an alias resolves to it', async () => {
  // Given a registered directory, its alias, and stale or malformed settings rows.
  const root = await fs.mkdtemp('/tmp/opencode/registered-project-');
  roots.push(root);
  const directory = path.join(root, 'project');
  const alias = path.join(root, 'alias');
  await fs.mkdir(directory);
  await fs.symlink(directory, alias);
  const readSettings = async () => ({ projects: [null, { path: 7 }, { path: path.join(root, 'gone') }, { path: directory, id: 'project-id' }] });
  // When the project is resolved through its alias.
  const project = await registeredTransferProject(alias, readSettings);
  // Then the canonical directory and existing project ID survive, including through the old route export.
  expect(project).toEqual({ directory, id: 'project-id' });
  expect(await registeredTransferDirectory(alias, readSettings)).toBe(directory);
  expect(await legacyDirectory(alias, readSettings)).toBe(directory);
});

test('reports an invalid directory when the project path no longer exists', async () => {
  // Given a project whose registered path has disappeared.
  const root = await fs.mkdtemp('/tmp/opencode/registered-project-');
  roots.push(root);
  const directory = path.join(root, 'gone');
  // When the directory is resolved, then the original filesystem failure code is preserved.
  await expect(registeredTransferDirectory(directory, async () => ({ projects: [{ path: directory }] })))
    .rejects.toMatchObject({ code: 'agent_directory_invalid' });
});

test('reports an unregistered project when the settings have no projects', async () => {
  // Given an existing directory and settings without a project list.
  const directory = await fs.mkdtemp('/tmp/opencode/registered-project-');
  roots.push(directory);
  // When registration is resolved, then the existing unregistered-project code is returned.
  await expect(registeredTransferDirectory(directory, async () => ({})))
    .rejects.toMatchObject({ code: 'agent_project_unregistered' });
});
