import {
  BROWSER_PROVIDER_ACTION_TIMEOUT_MS,
  BROWSER_PROVIDER_OPEN_TIMEOUT_MS,
} from '@openchamber/sdk';

export const HELP_ACTION = 'browser.requestHelp';
export const SAVE_ACTION = 'browser.saveProfile';
const SAVE_TIMEOUT_MS = 45_000;
const HELP_KINDS = new Set(['login', 'page', 'profile']);
const PROFILE_NAME_MAX = 80;
const HELP_TIMEOUT_MIN_S = 30;
const HELP_TIMEOUT_MAX_S = 900;
const HELP_TIMEOUT_DEFAULT_S = 300;
const HELP_REASON_MAX = 300;

export const readHelpRequest = (body) => {
  let wire;
  try {
    wire = JSON.parse(body);
  } catch {
    return null;
  }
  if (!wire || typeof wire !== 'object' || (wire.action !== HELP_ACTION && wire.action !== SAVE_ACTION)) return null;
  if (typeof wire.requestId !== 'string' || wire.requestId.length === 0) return null;
  const parameters = wire.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
  const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
  const context = { directory: text(wire.context?.directory), sessionId: text(wire.context?.sessionId) };
  if (parameters.tabId !== undefined && (typeof parameters.tabId !== 'string' || parameters.tabId.length === 0 || parameters.tabId.length > 128)) return null;
  if (wire.action === SAVE_ACTION) return { requestId: wire.requestId, action: SAVE_ACTION, parameters: {}, context };
  const kind = parameters.kind ?? 'page';
  if (!HELP_KINDS.has(kind)) return null;
  const reason = typeof parameters.reason === 'string' ? parameters.reason.trim() : '';
  const timeoutSeconds = parameters.timeoutSeconds ?? HELP_TIMEOUT_DEFAULT_S;
  if (reason.length === 0 || reason.length > HELP_REASON_MAX) return null;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < HELP_TIMEOUT_MIN_S || timeoutSeconds > HELP_TIMEOUT_MAX_S) return null;
  const helpParameters = { reason, timeoutSeconds, kind };
  if (parameters.tabId !== undefined) helpParameters.tabId = parameters.tabId;
  if (parameters.profileName !== undefined) {
    const profileName = String(parameters.profileName).trim();
    if (kind !== 'profile' || profileName.length === 0 || profileName.length > PROFILE_NAME_MAX) return null;
    helpParameters.profileName = profileName;
  }
  return { requestId: wire.requestId, action: HELP_ACTION, parameters: helpParameters, context };
};

export const actionDeadlineMs = (parsed) => {
  if (parsed.action === HELP_ACTION) return parsed.parameters.timeoutSeconds * 1000 + 10_000;
  if (parsed.action === SAVE_ACTION) return SAVE_TIMEOUT_MS - 2_000;
  return (parsed.action === 'browser.open' ? BROWSER_PROVIDER_OPEN_TIMEOUT_MS : BROWSER_PROVIDER_ACTION_TIMEOUT_MS) - 2_000;
};
