import { proxyGuestServiceRequest } from '@/lib/guests/service';

/**
 * Built-in extension id for the server browser (Chrome on the OpenChamber
 * server). Reached through the host proxy
 * `POST /api/guests/{id}/service/request`, same as any other guest service.
 * See `.omo/plans/native-server-browser-contract.md`.
 */
export const SERVER_BROWSER_GUEST_ID = 'openchamber-builtin-server-browser';

export interface BrowserProfileChatUser {
  directory: string;
  sessionId: string;
  copyVersion: number | null;
}

export interface BrowserProfile {
  id: string;
  name: string;
  /** Absolute project directories bound to this profile. */
  projects: string[];
  createdAt: number;
  lastUsedAt: number | null;
  /** Bumped by one on every successful save; doubles as "saved N times". */
  version: number;
  savedAt: number | null;
  saved: boolean;
  savedBytes: number;
  /** Someone has this profile's sign-in browser open right now. */
  signingIn: boolean;
  /** Chats currently browsing on a copy of this profile. */
  chats: BrowserProfileChatUser[];
}

export type ChromeStatusKind = 'idle' | 'installing' | 'ready' | 'system' | 'missing-libraries' | 'failed';

export interface ChromeStatus {
  status: ChromeStatusKind;
  message: string;
  path?: string;
  version?: string;
}

export interface BrowserStateScope {
  id: string;
  directory: string;
  sessionId: string;
  profile: { id: string; name: string; copyVersion: number | null; users: number } | null;
  signIn: boolean;
  selected: boolean;
  url: string;
  title: string;
}

export interface BrowserState {
  controller: 'none' | 'user';
  viewerInControl: boolean;
  selectedScopeId: string | null;
  generation: number;
  chrome: ChromeStatus;
  scopes: BrowserStateScope[];
}

export interface ProfileSite {
  domain: string;
  cookies: number;
}

/** A call reached the extension but it answered with a non-2xx status. */
export interface ServerBrowserHttpError {
  ok: false;
  kind: 'http';
  status: number;
  message: string;
}

/** The host proxy itself could not reach the extension (not installed, disabled, service down…). */
export interface ServerBrowserUnavailable {
  ok: false;
  kind: 'unavailable';
  message: string;
}

export type ServerBrowserError = ServerBrowserHttpError | ServerBrowserUnavailable;
export type ServerBrowserResult<T> = { ok: true; value: T } | ServerBrowserError;

const parseJsonBody = (body: string): unknown => {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const errorFromBody = (status: number, body: string): string => {
  const parsed = parseJsonBody(body);
  if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string') {
    return (parsed as { error: string }).error;
  }
  return body || `Request failed (${status}).`;
};

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
): Promise<ServerBrowserResult<T>> {
  const result = await proxyGuestServiceRequest(SERVER_BROWSER_GUEST_ID, {
    method,
    path,
    ...(options.query ? { query: options.query } : {}),
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  // The host proxy could not reach the service at all (not installed, disabled,
  // the child process is down…). Anything past this point reached the
  // extension, so a 4xx/5xx from it is a normal `kind: 'http'` error instead.
  if (!result.ok) {
    return { ok: false, kind: 'unavailable', message: result.message };
  }

  const { status, body } = result.result;
  if (status < 200 || status >= 300) {
    return { ok: false, kind: 'http', status, message: errorFromBody(status, body) };
  }

  const parsed = parseJsonBody(body);
  return { ok: true, value: parsed as T };
}

export const getBrowserState = (): Promise<ServerBrowserResult<BrowserState>> => (
  request<BrowserState>('GET', '/browser/state')
);

export const getChromeStatus = (): Promise<ServerBrowserResult<ChromeStatus>> => (
  request<ChromeStatus>('GET', '/chrome')
);

interface ProfilesMutationResponse {
  ok: true;
  profiles: BrowserProfile[];
  state: BrowserState;
}

export const listProfiles = (): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('GET', '/profiles')
);

export const createProfile = (name: string): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('POST', '/profiles/create', { body: { name } })
);

export const renameProfile = (id: string, name: string): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('POST', '/profiles/rename', { body: { id, name } })
);

export const bindProfile = (id: string, directory: string): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('POST', '/profiles/bind', { body: { id, directory } })
);

export const unbindProfile = (id: string, directory: string): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('POST', '/profiles/unbind', { body: { id, directory } })
);

export const deleteProfile = (id: string): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('POST', '/profiles/delete', { body: { id } })
);

export const openProfile = (id: string, generation: number): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('POST', '/profiles/open', { body: { id, generation } })
);

export const closeProfile = (id: string): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('POST', '/profiles/close', { body: { id } })
);

export const revokeAllProfiles = (): Promise<ServerBrowserResult<ProfilesMutationResponse>> => (
  request<ProfilesMutationResponse>('POST', '/profiles/revoke-all', { body: { confirm: 'REVOKE' } })
);

export const getProfileSites = (id: string): Promise<ServerBrowserResult<{ ok: true; sites: ProfileSite[] }>> => (
  request<{ ok: true; sites: ProfileSite[] }>('GET', '/profiles/sites', { query: { id } })
);

export const clearProfileSite = (id: string, domain: string): Promise<ServerBrowserResult<{ ok: true; sites: ProfileSite[] }>> => (
  request<{ ok: true; sites: ProfileSite[] }>('POST', '/profiles/sites/clear', { body: { id, domain } })
);

/** Whether a failed call means the extension is not usable at all (vs. a one-off error). */
export interface NetworkPolicyState {
  ok: true;
  allowPrivateNetwork: boolean;
  source: 'settings' | 'config' | 'default';
  defaultValue: boolean;
  personalMachine: boolean;
}

export const getNetworkPolicy = (): Promise<ServerBrowserResult<NetworkPolicyState>> => (
  request<NetworkPolicyState>('GET', '/network')
);

/** `null` returns to the default for where OpenChamber runs. */
export const setNetworkPolicy = (allowPrivateNetwork: boolean | null): Promise<ServerBrowserResult<NetworkPolicyState>> => (
  request<NetworkPolicyState>('POST', '/network', { body: { allowPrivateNetwork } })
);

export const isServerBrowserUnavailable = (error: ServerBrowserError): boolean => error.kind === 'unavailable';

/** The error thrown by the service when another viewer holds the shared surface. */
export const isDockAccessError = (message: string): boolean => (
  /available only while the shared surface is idle/i.test(message)
);

/** The error thrown by the service when a sign-in copy was saved over a newer version. */
export const isStaleProfileError = (message: string): boolean => (
  /saved this profile while you were signing in|saved over it/i.test(message)
);
