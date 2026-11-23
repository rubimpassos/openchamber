import path from 'node:path';
import { z } from 'zod';
import { createSettingsNormalizationRuntime } from '../settings/settings-normalization-runtime.js';
import { hasProperties } from '../shared/guards.js';

const refusal = (code: string) => Object.assign(new Error(code), { code });
const SPACE_ROOTS = ['/spaces', '/var/lib/openchamber-spaces', '/var/lib/private/openchamber-spaces', '/var/lib/openchamber-hostd/spaces'] as const;

// A project folder as the registry keeps it: absolute, normalized, trimmed and free of control characters.
const registryPathSchema = z.string().min(1).max(4096).refine((value) => value === value.trim()
  && !value.includes('\\') && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  && path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && value !== '/' && !value.endsWith('/'));
// A registry entry names its project with an id that is not blank.
const registryEntrySchema = z.object({ id: z.string().refine((id) => id.trim() !== '') });

/** No stat, realpath, home expansion, or agent-provided ownership claim. */
export const normalizeRegistryProjectPath = (value: unknown) => {
  const parsed = registryPathSchema.safeParse(value);
  if (!parsed.success) throw refusal('project_path_invalid');
  if (SPACE_ROOTS.some((root) => parsed.data === root || parsed.data.startsWith(`${root}/`))) {
    throw refusal('space_project_refused');
  }
  return parsed.data;
};

// Reuse the normal record projection without either filesystem dependency.
const lexical = createSettingsNormalizationRuntime({
  path: path.posix,
  os: { homedir: () => { throw refusal('project_path_invalid'); } },
  processLike: { platform: 'linux' },
});

const isRegistryEntry = (value: unknown): value is { readonly id: string; readonly path?: unknown } =>
  registryEntrySchema.safeParse(value).success;

export const sanitizeRegistryProjects = (projects: unknown) => {
  if (!Array.isArray(projects)) throw refusal('project_registry_invalid');
  const ids = new Set<string>();
  const paths = new Set<unknown>();
  const entries: readonly unknown[] = projects;
  for (const project of entries) {
    if (!isRegistryEntry(project)) throw refusal('project_registry_invalid');
    normalizeRegistryProjectPath(project.path);
    const id = project.id.trim();
    if (ids.has(id) || paths.has(project.path)) throw refusal('project_registry_invalid');
    ids.add(id);
    paths.add(project.path);
  }
  return lexical.sanitizeProjects(projects) ?? [];
};

type ProjectRegistryDependencies = {
  readonly ownsProject?: ((directory: string) => boolean | Promise<boolean>) | undefined;
  readonly shareProject?: ((directory: string) => void) | undefined;
};

export const createProjectRegistry = ({
  ownsProject = async () => false,
  shareProject = async () => { throw refusal('share_project_unavailable'); },
}: ProjectRegistryDependencies = {}) => {
  const authorizeProject = async (value: unknown) => {
    const directory = normalizeRegistryProjectPath(value);
    if (await ownsProject(directory) !== true) await shareProject(directory);
    return directory;
  };

  // The settings runtime calls this inside its write lock, before any write.
  const beforeProjectsSave = async (projects: unknown, currentProjects: readonly unknown[] = []) => {
    const next = sanitizeRegistryProjects(projects);
    const knownPaths = new Set(currentProjects.map((project) => hasProperties(project) ? project.path : undefined));
    for (const project of next) {
      if (knownPaths.has(project.path)) continue;
      await authorizeProject(project.path);
      knownPaths.add(project.path);
    }
  };

  return { authorizeProject, beforeProjectsSave };
};
