import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { bundleFailure } from '../spaces/transfer-bundle.js';

export const registeredTransferDirectorySchema = z.string().min(1).max(4096)
  .refine((value) => path.isAbsolute(value) && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const registeredProjectSchema = z.object({ path: z.string(), id: z.string().optional() });

export type TransferProjectSettings = { readonly projects?: readonly unknown[] | null | undefined };
export type ReadTransferProjectSettings = () => TransferProjectSettings | Promise<TransferProjectSettings>;
export type RegisteredTransferProject = { readonly directory: string; readonly id: string | undefined };

export async function registeredTransferProject(value: string | null | undefined, readSettings: ReadTransferProjectSettings): Promise<RegisteredTransferProject> {
  const input = registeredTransferDirectorySchema.safeParse(value);
  if (!input.success) throw bundleFailure('agent_directory_invalid');
  const directory = await fs.realpath(path.resolve(input.data)).catch(() => { throw bundleFailure('agent_directory_invalid'); });
  const settings = await readSettings();
  for (const project of settings.projects ?? []) {
    const parsed = registeredProjectSchema.safeParse(project);
    if (!parsed.success) continue;
    const registered = await fs.realpath(path.resolve(parsed.data.path)).catch(() => null);
    if (registered === directory) return { directory, id: parsed.data.id };
  }
  throw bundleFailure('agent_project_unregistered');
}

export async function registeredTransferDirectory(value: string | null | undefined, readSettings: ReadTransferProjectSettings): Promise<string> {
  return (await registeredTransferProject(value, readSettings)).directory;
}
