import { realpath } from 'node:fs/promises';
import { resolveRequestedDirectory } from '../openchamber-sessions/routes.js';
import { ACTIONS, ERROR_DEFINITIONS, inputSchemas } from './contract.js';
import type { IntegrationAction, IntegrationErrorCode } from './contract.js';
import type { IntegrationCredential } from './policy.js';
import type { SessionServiceDependencies } from '../openchamber-sessions/routes.js';
import type { ControlDependencies, createOpenChamberControlService } from '../openchamber-control/service.js';
import type { ControlInput } from '../openchamber-control/contracts.js';

export type IntegrationScopeDependencies = Pick<SessionServiceDependencies, 'readSettingsFromDiskMigrated' | 'validateDirectoryPath'>
  & Pick<ControlDependencies, 'sanitizeProjects'>
  & { readonly controlService: Pick<ReturnType<typeof createOpenChamberControlService>, 'resolveSessionDirectory'> };
type CredentialScope = Pick<IntegrationCredential, 'actions' | 'projectIds'>;
type Project = ReturnType<ControlDependencies['sanitizeProjects']>[number];
type SessionIdentity = { readonly projectId: string; readonly sessionId: string };
type ScopedInput = ControlInput & { readonly directory?: string; limit?: number; readonly all?: boolean };
type AuthorizedScope = {
  readonly action: IntegrationAction;
  readonly projectId?: string;
  readonly directory?: string;
  readonly sessionId?: string;
  readonly controlInput: ScopedInput;
};
export type SessionRow = { readonly id?: string; readonly title?: string; readonly time?: { readonly archived?: number } };

export class IntegrationScopeError extends Error {
  readonly code: IntegrationErrorCode;
  readonly statusCode: number;
  constructor(code: IntegrationErrorCode) {
    super(ERROR_DEFINITIONS[code].message);
    this.name = 'IntegrationScopeError';
    this.code = code;
    this.statusCode = ERROR_DEFINITIONS[code].statusCode;
  }
}

const deny = (code: IntegrationErrorCode): never => { throw new IntegrationScopeError(code); };
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
}: IntegrationScopeDependencies) => {
  const checkAction = (credential: CredentialScope, action: IntegrationAction) => {
    if (!ACTIONS.includes(action) || !credential?.actions?.includes(action)) deny('ACTION_DENIED');
  };

  // The UI validator caches realpaths. Resolve afresh first so a changed symlink
  // cannot reuse a formerly authorized directory during that cache's TTL.
  const validateCanonicalDirectory = async (directory: string | null) =>
    validateDirectoryPath(await realpath(directory ?? ''));

  const readProjects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const projects = sanitizeProjects(settings?.projects || []) || [];
    const canonical = [];
    for (const project of projects) {
      // An unavailable directory denies only that project, not healthy peers.
      const validated = await validateCanonicalDirectory(project.path).catch(() => null);
      if (!validated?.ok) continue;
      canonical.push({ ...project, path: validated.directory });
    }
    // An ambiguous registry is not an authorization decision.
    if (new Set(canonical.map(({ id }) => id)).size !== canonical.length
      || new Set(canonical.map(({ path }) => path)).size !== canonical.length) deny('PROJECT_DENIED');
    return canonical;
  };

  const resolveDirectory = async (directory: string, projects: Project[]) => {
    const resolved = await resolveRequestedDirectory({
      payload: { directory },
      readSettingsFromDiskMigrated: async () => ({ projects }),
      sanitizeProjects: () => projects,
      validateDirectoryPath: validateCanonicalDirectory,
    });
    if (!resolved.ok || !resolved.projectId) return deny('PROJECT_DENIED');
    return { projectId: resolved.projectId, directory: resolved.directory };
  };

  const resolveSession = async (credential: CredentialScope, input: SessionIdentity, projects: Project[]) => {
    const directory = await controlService.resolveSessionDirectory(input.sessionId);
    if (!directory) return deny('SESSION_NOT_FOUND');
    const resolved = await resolveDirectory(directory, projects);
    if (resolved.projectId !== input.projectId
      || !credential.projectIds?.includes(resolved.projectId)) deny('SESSION_NOT_FOUND');
    return { ...resolved, sessionId: input.sessionId };
  };

  const authorize = async (credential: CredentialScope, action: IntegrationAction, input: unknown = {}): Promise<AuthorizedScope> => {
    checkAction(credential, action);
    const code = sessionActions.has(action) ? 'SESSION_NOT_FOUND' : 'PROJECT_DENIED';
    try {
      const parsed = inputSchemas[action].safeParse(input);
      if (!parsed.success) return deny(code);
      if (action === 'projects.list') return { action, controlInput: {} };
      if (!('projectId' in parsed.data)) return deny(code);
      const projects = await readProjects();
      let resolved;
      if (sessionActions.has(action)) {
        if (!('sessionId' in parsed.data)) return deny(code);
        resolved = await resolveSession(credential, { projectId: parsed.data.projectId, sessionId: parsed.data.sessionId }, projects);
      } else {
        const project = projects.find(({ id }) => id === parsed.data.projectId);
        if (!project) return deny(code);
        resolved = await resolveDirectory(project.path, projects);
        if (!credential.projectIds?.includes(resolved.projectId)) deny(code);
      }
      const { projectId: _projectId, ...controlInput } = parsed.data;
      // Wire defaults and native lastAssistant semantics differ.
      if (action === 'session.messages' && 'lastAssistant' in controlInput && controlInput.lastAssistant === true
        && 'limit' in controlInput) delete controlInput.limit;
      return { action, ...resolved, controlInput: { ...controlInput, directory: resolved.directory } };
    } catch {
      // Neither the existence of a foreign session nor an I/O error is public.
      return deny(code);
    }
  };

  const filterProjects = async (credential: CredentialScope) => {
    checkAction(credential, 'projects.list');
    try {
      const projects = await readProjects();
      return projects.filter(({ id }) => credential.projectIds?.includes(id))
        .map(({ id, label }) => {
          const project: { id: string; label?: string } = { id };
          if (label) project.label = label;
          return project;
        });
    } catch {
      return deny('PROJECT_DENIED');
    }
  };

  const filterSessions = async (credential: CredentialScope, input: unknown, sessions: readonly SessionRow[]) => {
    const authorized = await authorize(credential, 'session.list', input);
    const projects = await readProjects().catch(() => deny('PROJECT_DENIED'));
    if (!authorized.projectId) return deny('PROJECT_DENIED');
    const visible = [];
    for (const session of sessions) {
      if (!session?.id || (session.time?.archived && !authorized.controlInput.all)) continue;
      try {
        // Do not trust a row's claimed directory/projectId or any plugin marker.
        await resolveSession(credential, { projectId: authorized.projectId, sessionId: session.id }, projects);
        const projected: { id: string; title?: string } = { id: session.id };
        if (session.title) projected.title = session.title;
        visible.push(projected);
      } catch {
        continue;
      }
      if (visible.length >= (authorized.controlInput.limit ?? 10)) break;
    }
    return visible;
  };

  return { authorize, filterProjects, filterSessions };
};
