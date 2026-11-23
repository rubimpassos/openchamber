import {
  BROWSER_CONTROL_ACTIONS,
  BROWSER_PROVIDER_ACTION_TIMEOUT_MS,
  BROWSER_PROVIDER_IDLE_MS,
  BROWSER_PROVIDER_OPEN_TIMEOUT_MS,
  BROWSER_PROVIDER_PATH,
  BROWSER_PROVIDER_RESPONSE_MAX,
  isGuestApproved,
  requestedGuestCapabilities,
  serviceProvides,
} from '@openchamber/sdk';
import { browserProviderResultSchema } from '@openchamber/sdk/schemas';
import type { z } from 'zod';

import { GuestServiceError, proxyGuestServiceRequest } from '../guests/service.js';
import { BrowserControlError } from './broker.js';
import type { BrowserProviderContext, GuestCapability, OpenChamberContributes, ServiceContribution } from '@openchamber/sdk';
import type { BrowserControlOptions, BrowserControlParameters, createBrowserControlBroker } from './broker.js';

export interface BrowserProviderGuest extends Omit<OpenChamberContributes, 'panel'> {
  id: string;
  name: string;
  packageRoot: string;
  enabled?: boolean;
  capabilityGrants: GuestCapability[];
}

export interface BrowserProviderReset {
  guestId: string;
  guestName: string;
}

export interface BrowserControlRouterOptions {
  broker: Pick<ReturnType<typeof createBrowserControlBroker>, 'request'>;
  readSettings: () => Promise<{ browserProvider?: unknown } | null>;
  persistSettings: (changes: { browserProvider: string }) => void;
  findGuest: (id: string) => Promise<BrowserProviderGuest | null>;
  persistPath: string;
  emitProviderReset: (event: BrowserProviderReset) => void;
  createId: () => string;
  proxyServiceRequest?: typeof proxyGuestServiceRequest;
  surfaceControl?: {
    userControls: (guestId: string) => boolean;
    noteAgentActivity: (guestId: string) => void;
  };
  notifyBrowserHelp?: (event: {
    readonly guestId: string;
    readonly guestName: string;
    readonly reason: BrowserControlParameters['reason'];
    readonly kind: BrowserControlParameters['kind'];
    readonly context: BrowserProviderContext;
  }) => Promise<unknown>;
  announceAgentActivity?: (event: {
    readonly guestId: string;
    readonly action: string;
    readonly context: BrowserProviderContext;
  }) => void;
}

const BUILTIN_BROWSER_PROVIDER = 'builtin';
/**
 * Unset `browserProvider` resolves to the built-in Server Browser extension,
 * not the in-app webview/iframe: a fresh instance can browse from no client
 * at all. `builtin` keeps its own meaning and is still what a broken or
 * disabled provider resets to.
 */
const DEFAULT_BROWSER_PROVIDER = 'openchamber-builtin-server-browser';

/**
 * `browser.requestHelp` hands a person a picture of the page, so it needs a
 * provider with a shared surface to draw it in; the in-app browser view has
 * no such surface, and neither does a selected extension without one.
 */
const BROWSER_REQUEST_HELP_NO_SURFACE_ERROR = 'Asking for help needs a browser provider extension with a shared surface (Settings → OpenChamber Tools → Browser provider).';

/** The in-app browser has one shared, un-copied session; there is no saved profile to write. */
const BROWSER_SAVE_PROFILE_NO_PROVIDER_ERROR = 'Saving a browser profile needs the Server Browser extension (Settings → OpenChamber Tools → Browser provider).';
// The in-app view answers a page's dialogs itself, so it never has one waiting.
const BROWSER_DIALOG_NO_PROVIDER_ERROR = 'No dialog is waiting in the in-app browser: its pages answer their own dialogs. browser.dialog is for the Server Browser extension (Settings → OpenChamber Tools → Browser provider).';

const UNKNOWN_CONTEXT = Object.freeze({ directory: null, sessionId: null });

export const isBrowserProviderGuest = (guest: BrowserProviderGuest | null): guest is BrowserProviderGuest & { service: ServiceContribution } => (
  Boolean(guest)
  && guest !== null && guest.enabled !== false
  && serviceProvides(guest.service, 'browser')
  && isGuestApproved({
    requested: requestedGuestCapabilities(guest),
    granted: Array.isArray(guest.capabilityGrants) ? guest.capabilityGrants : [],
  })
);

export const createBrowserControlRouter = ({
  broker,
  readSettings,
  persistSettings,
  findGuest,
  persistPath,
  emitProviderReset,
  createId,
  proxyServiceRequest = proxyGuestServiceRequest,
  surfaceControl = { userControls: () => false, noteAgentActivity: () => undefined },
  notifyBrowserHelp = async () => undefined,
  announceAgentActivity = () => undefined,
}: BrowserControlRouterOptions) => {
  const selectedProviderId = async () => {
    let settings;
    try {
      settings = await readSettings();
    } catch {
      throw new BrowserControlError(
        'OpenChamber could not read which browser answers agent actions, so the action was not run. Try again.',
        503,
      );
    }
    const value = settings?.browserProvider ?? DEFAULT_BROWSER_PROVIDER;
    return value === BUILTIN_BROWSER_PROVIDER ? null : String(value);
  };

  const resetToBuiltin = async ({ guestId, guestName }: BrowserProviderReset) => {
    await persistSettings({ browserProvider: BUILTIN_BROWSER_PROVIDER });
    emitProviderReset({ guestId, guestName });
  };

  const requestFromProvider = async (guest: BrowserProviderGuest & { service: ServiceContribution }, action: string, parameters: BrowserControlParameters, { signal, timeoutMs, context }: BrowserControlOptions) => {
    if (surfaceControl.userControls(guest.id)) {
      throw new BrowserControlError(
        'The user is interacting with this page in the panel right now, so the action was not run. '
        + 'Wait for them to hand control back, or ask them to. Nothing was changed.',
        409,
      );
    }
    if (action === 'browser.requestHelp') {
      // Best-effort: the person seeing the notification matters, but a
      // notification failure must not also fail the help request itself.
      try {
        await notifyBrowserHelp({
          guestId: guest.id,
          guestName: guest.name,
          reason: parameters?.reason,
          kind: parameters?.kind,
          context: context ?? UNKNOWN_CONTEXT,
        });
      } catch (error) {
        console.warn('[browser-provider] could not notify the user about a help request:', error instanceof Error ? error.message : error);
      }
    }
    surfaceControl.noteAgentActivity(guest.id);
    // Closing a tab is no reason to bring the browser in front.
    if (action !== 'browser.close') {
      announceAgentActivity({ guestId: guest.id, action, context: context ?? UNKNOWN_CONTEXT });
    }
    const requestId = createId();
    let proxied;
    try {
      proxied = await proxyServiceRequest({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        granted: guest.capabilityGrants,
        persistPath,
        method: 'POST',
        path: BROWSER_PROVIDER_PATH,
        body: JSON.stringify({ requestId, action, parameters, context: context ?? UNKNOWN_CONTEXT }),
        timeoutMs: timeoutMs ?? (action === 'browser.open' ? BROWSER_PROVIDER_OPEN_TIMEOUT_MS : BROWSER_PROVIDER_ACTION_TIMEOUT_MS),
        responseMax: BROWSER_PROVIDER_RESPONSE_MAX,
        idleStopMs: BROWSER_PROVIDER_IDLE_MS,
        signal,
      });
    } catch (error) {
      if (error instanceof GuestServiceError) {
        const outcome = error.code === 'RESPONSE_TOO_LARGE'
          ? 'The action ran, but its answer was too large to read; read the page before repeating it.'
          : error.code === 'REQUEST_FAILED' || error.code === 'CANCELLED'
            ? 'The action was sent but no answer came back, so it may or may not have run; read the page before repeating it.'
            : 'Nothing was changed.';
        throw new BrowserControlError(
          `The browser provider "${guest.name}" could not complete this action (${error.code}): ${error.message} ${outcome}`,
          error.code === 'REQUEST_FAILED' ? 504 : error.code === 'RESPONSE_TOO_LARGE' ? 502 : 503,
        );
      }
      throw error;
    }
    if (proxied.status !== 200) {
      throw new BrowserControlError(
        `The browser provider "${guest.name}" answered HTTP ${proxied.status} instead of a result. Nothing is known about the page.`,
        502,
      );
    }
    let parsed: z.ZodSafeParseResult<z.infer<typeof browserProviderResultSchema>> | { success: false };
    try {
      parsed = browserProviderResultSchema.safeParse(JSON.parse(proxied.body));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) {
      throw new BrowserControlError(
        `The browser provider "${guest.name}" answered something that is not a browser result. Nothing is known about the page.`,
        502,
      );
    }
    if (!parsed.data.ok) {
      throw new BrowserControlError(parsed.data.error, 400);
    }
    return parsed.data.data;
  };

  return {
    async request(action: string, parameters: BrowserControlParameters = {}, options: BrowserControlOptions = {}) {
      const providerId = await selectedProviderId();
      if (!providerId) {
        if (action === 'browser.requestHelp') {
          throw new BrowserControlError(BROWSER_REQUEST_HELP_NO_SURFACE_ERROR, 400);
        }
        if (action === 'browser.saveProfile') {
          throw new BrowserControlError(BROWSER_SAVE_PROFILE_NO_PROVIDER_ERROR, 400);
        }
        if (action === 'browser.dialog') {
          throw new BrowserControlError(BROWSER_DIALOG_NO_PROVIDER_ERROR, 400);
        }
        return broker.request(action, parameters, options);
      }
      let guest;
      try {
        guest = await findGuest(providerId);
      } catch {
        throw new BrowserControlError(
          'OpenChamber could not read the extension catalog, so the action was not run. Try again.',
          503,
        );
      }
      if (!isBrowserProviderGuest(guest)) {
        await resetToBuiltin({ guestId: providerId, guestName: guest?.name ?? providerId });
        if (action === 'browser.requestHelp') {
          throw new BrowserControlError(BROWSER_REQUEST_HELP_NO_SURFACE_ERROR, 400);
        }
        if (action === 'browser.saveProfile') {
          throw new BrowserControlError(BROWSER_SAVE_PROFILE_NO_PROVIDER_ERROR, 400);
        }
        if (action === 'browser.dialog') {
          throw new BrowserControlError(BROWSER_DIALOG_NO_PROVIDER_ERROR, 400);
        }
        return broker.request(action, parameters, options);
      }
      if (action === 'browser.requestHelp' && guest.service?.surface !== true) {
        throw new BrowserControlError(BROWSER_REQUEST_HELP_NO_SURFACE_ERROR, 400);
      }
      if (!BROWSER_CONTROL_ACTIONS.some((candidate) => candidate === action)) {
        throw new BrowserControlError(
          `The browser provider "${guest.name}" does not offer ${action}; it answers ${BROWSER_CONTROL_ACTIONS.join(', ')}. Nothing was changed.`,
          400,
        );
      }
      return requestFromProvider(guest, action, parameters, options);
    },

    async handleGuestDeactivated({ guestId, guestName }: BrowserProviderReset) {
      try {
        const providerId = await selectedProviderId();
        if (providerId !== guestId) return false;
        await resetToBuiltin({ guestId, guestName: guestName || guestId });
        return true;
      } catch (error) {
        console.warn('[browser-provider] could not reset the provider after a deactivation:', error instanceof Error ? error.message : error);
        return false;
      }
    },
  };
};
