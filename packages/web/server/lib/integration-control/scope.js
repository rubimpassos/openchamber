import { realpath } from 'node:fs/promises';
import { resolveRequestedDirectory } from '../openchamber-sessions/routes.js';
import { ACTIONS, ERROR_DEFINITIONS, inputSchemas } from './contract.js';

export class IntegrationScopeError extends Error {
  constructor(code) {
    super(ERROR_DEFINITIONS[code].message);
    this.name = 'IntegrationScopeError';
    this.code = code;
    this.statusCode = ERROR_DEFINITIONS[code].statusCode;
  }
}

const deny = (code) => { throw new IntegrationScopeError(code); };
const sessionActions = new Set(['session.send', 'session.fork', 'session.status', 'session.messages']);

/**
 * Server-only dependencies, never wire input. controlService is the existing
 * createOpenChamberControlService instance. Its persisted-directory lookup also
 * covers human sessions; a null (including lookup failure) always denies access.
 *
 * authorize returns canonical identity plus controlInput for native execute().
 * Do not merge wire projectId back into controlInput: native session dispatch
 * gives projectId precedence over directory and would leave the worktree.
 * List adapters must use filterProjects/filterSessions before serialization.
 * No lifecycle operations or authentication are performed here.
 */
export const createIntegrationScope = ({
  readSettingsFromDiskMigrated, sanitizeProjects, validateDirectoryPath, controlService,
}) => {
  const checkAction = (credential, action) => {
    if (!ACTIONS.includes(action) || !credential?.actions?.includes(action)) deny('ACTION_DENIED');
  };

  // The UI validator caches realpaths. Resolve afresh first so a changed symlink
  // cannot reuse a formerly authorized directory during that cache's TTL.
  const validateCanonicalDirectory = async (directory) => validateDirectoryPath(await realpath(directory));

  const readProjects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const projects = sanitizeProjects(settings?.projects || []) || [];
    const canonical = [];
    for (const project of projects) {
      const validated = await validateCanonicalDirectory(project.path);
      if (!validated.ok) deny('PROJECT_DENIED');
      canonical.push({ ...project, path: validated.directory });
    }
    // An ambiguous registry is not an authorization decision.
    if (new Set(canonical.map(({ id }) => id)).size !== canonical.length
      || new Set(canonical.map(({ path }) => path)).size !== canonical.length) deny('PROJECT_DENIED');
    return canonical;
  };

  const resolveDirectory = async (directory, projects) => {
    const resolved = await resolveRequestedDirectory({
      payload: { directory },
      readSettingsFromDiskMigrated: async () => ({ projects }),
      sanitizeProjects: () => projects,
      validateDirectoryPath: validateCanonicalDirectory,
    });
    if (!resolved.ok || !resolved.projectId) deny('PROJECT_DENIED');
    return { projectId: resolved.projectId, directory: resolved.directory };
  };

  const resolveSession = async (credential, input, projects) => {
    const directory = await controlService.resolveSessionDirectory(input.sessionId);
    if (!directory) deny('SESSION_NOT_FOUND');
    const resolved = await resolveDirectory(directory, projects);
    if (resolved.projectId !== input.projectId
      || !credential.projectIds?.includes(resolved.projectId)) deny('SESSION_NOT_FOUND');
    return { ...resolved, sessionId: input.sessionId };
  };

  const authorize = async (credential, action, input = {}) => {
    checkAction(credential, action);
    const code = sessionActions.has(action) ? 'SESSION_NOT_FOUND' : 'PROJECT_DENIED';
    try {
      const parsed = inputSchemas[action].safeParse(input);
      if (!parsed.success) deny(code);
      if (action === 'projects.list') return { action, controlInput: {} };
      const projects = await readProjects();
      let resolved;
      if (sessionActions.has(action)) {
        resolved = await resolveSession(credential, parsed.data, projects);
      } else {
        const project = projects.find(({ id }) => id === parsed.data.projectId);
        if (!project) deny(code);
        resolved = await resolveDirectory(project.path, projects);
        if (!credential.projectIds?.includes(resolved.projectId)) deny(code);
      }
      const { projectId: _projectId, ...controlInput } = parsed.data;
      // Wire defaults and native lastAssistant semantics differ.
      if (action === 'session.messages' && controlInput.lastAssistant === true) delete controlInput.limit;
      return { action, ...resolved, controlInput: { ...controlInput, directory: resolved.directory } };
    } catch {
      // Neither the existence of a foreign session nor an I/O error is public.
      deny(code);
    }
  };

  const filterProjects = async (credential) => {
    checkAction(credential, 'projects.list');
    try {
      const projects = await readProjects();
      return projects.filter(({ id }) => credential.projectIds?.includes(id))
        .map(({ id, label }) => ({ id, ...(label ? { label } : {}) }));
    } catch {
      deny('PROJECT_DENIED');
    }
  };

  const filterSessions = async (credential, input, sessions) => {
    const authorized = await authorize(credential, 'session.list', input);
    const projects = await readProjects().catch(() => deny('PROJECT_DENIED'));
    const visible = [];
    for (const session of sessions) {
      if (!session?.id || (session.time?.archived && !authorized.controlInput.all)) continue;
      try {
        // Do not trust a row's claimed directory/projectId or any plugin marker.
        await resolveSession(credential, { projectId: authorized.projectId, sessionId: session.id }, projects);
        visible.push({ id: session.id, ...(session.title ? { title: session.title } : {}) });
      } catch {
        continue;
      }
      if (visible.length >= authorized.controlInput.limit) break;
    }
    return visible;
  };

  return { authorize, filterProjects, filterSessions };
};
