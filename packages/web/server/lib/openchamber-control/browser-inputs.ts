import {
  BROWSER_PROVIDER_HELP_TIMEOUT_DEFAULT_S,
  BROWSER_PROVIDER_HELP_TIMEOUT_MAX_S,
  BROWSER_PROVIDER_HELP_TIMEOUT_MIN_S,
  BROWSER_REQUEST_HELP_KINDS,
  BROWSER_REQUEST_HELP_PROFILE_NAME_MAX,
} from '@openchamber/sdk';
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';
import type { BrowserControlParameters } from '../browser-control/broker.js';
import type { ControlInput } from './contracts.js';

export const BROWSER_DIALOG_PROMPT_TEXT_MAX = 10_000;
const BROWSER_REQUEST_HELP_REASON_MAX = 300;
const BROWSER_REQUEST_HELP_HOST_SLACK_MS = 15_000;
const SLOW_ACTIONS = new Set(['browser.open', 'browser.upload', 'browser.saveProfile']);

const readHelpTimeoutSeconds = (value: unknown) => {
  if (value === undefined || value === null) return BROWSER_PROVIDER_HELP_TIMEOUT_DEFAULT_S;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < BROWSER_PROVIDER_HELP_TIMEOUT_MIN_S || seconds > BROWSER_PROVIDER_HELP_TIMEOUT_MAX_S) {
    throw new OpenChamberControlError(
      `timeoutSeconds must be an integer from ${BROWSER_PROVIDER_HELP_TIMEOUT_MIN_S} to ${BROWSER_PROVIDER_HELP_TIMEOUT_MAX_S}`,
      400,
    );
  }
  return seconds;
};

const readHelpParameters = (input: ControlInput): BrowserControlParameters => {
  const reason = asNonEmptyString(input.reason);
  if (!reason) throw new OpenChamberControlError('reason is required for browser.requestHelp', 400);
  if (reason.length > BROWSER_REQUEST_HELP_REASON_MAX) {
    throw new OpenChamberControlError(`reason must be at most ${BROWSER_REQUEST_HELP_REASON_MAX} characters`, 400);
  }
  const requestedKind = asNonEmptyString(input.kind);
  const kind = requestedKind ? BROWSER_REQUEST_HELP_KINDS.find((known) => known === requestedKind) : 'page';
  if (!kind) throw new OpenChamberControlError(`kind must be one of ${BROWSER_REQUEST_HELP_KINDS.join(', ')}`, 400);
  const parameters: BrowserControlParameters = { reason, timeoutSeconds: readHelpTimeoutSeconds(input.timeoutSeconds), kind };
  const profileName = asNonEmptyString(input.profileName);
  if (!profileName) return parameters;
  if (kind !== 'profile') throw new OpenChamberControlError('profileName goes with kind profile only', 400);
  if (profileName.length > BROWSER_REQUEST_HELP_PROFILE_NAME_MAX) {
    throw new OpenChamberControlError(`profileName must be at most ${BROWSER_REQUEST_HELP_PROFILE_NAME_MAX} characters`, 400);
  }
  return { ...parameters, profileName };
};

export const addBrowserActionInputs = (action: string, input: ControlInput, parameters: BrowserControlParameters) => {
  if (action === 'browser.requestHelp') {
    Object.assign(parameters, readHelpParameters(input));
    return (parameters.timeoutSeconds ?? BROWSER_PROVIDER_HELP_TIMEOUT_DEFAULT_S) * 1000 + BROWSER_REQUEST_HELP_HOST_SLACK_MS;
  }
  return SLOW_ACTIONS.has(action) ? 45_000 : 20_000;
};
