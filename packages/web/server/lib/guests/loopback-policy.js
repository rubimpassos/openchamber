import { canonicalizeLoopbackPath, matchLoopbackRoute, requestedGuestCapabilities } from '@openchamber/sdk';
import { findInstalledGuest, invalidateGuestCatalog } from './catalog.js';
import { effectiveGrants, guestGrantScope } from './grant-scope.js';
import { resolveLoopbackTarget } from './loopback-target.js';
import { readExtensionStore } from './persist.js';

export class LoopbackError extends Error {
  /** @param {number} status @param {import('@openchamber/sdk').HostRequestErrorCode} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Admission and live reauthorization deliberately bypass the five-second manifest cache. */
export const authorizeLoopbackRequest = async (request, persistPath) => {
  invalidateGuestCatalog(persistPath);
  const guest = await findInstalledGuest(request.guestId, persistPath);
  if (!guest?.loopback) throw new LoopbackError(404, 'NOT_FOUND', 'Loopback contribution not found.');
  if (guest.enabled === false) throw new LoopbackError(403, 'DISABLED', 'Extension is disabled.');
  const target = resolveLoopbackTarget(guest.loopback);
  switch (target.status) {
    case 'config-invalid': throw new LoopbackError(400, 'HOST_REJECTED', 'Loopback configuration is invalid.');
    case 'ready': break;
    default: throw new LoopbackError(400, 'HOST_REJECTED', 'Loopback configuration is unavailable.');
  }
  const scope = guestGrantScope(guest, target);
  const stored = await readExtensionStore(persistPath);
  const grants = effectiveGrants(guest.capabilityGrants,
    guest.source === 'bundled' ? scope : stored.capabilityScopes[guest.id], scope);
  if (guest.enterpriseBlocked?.length || !grants.includes('loopback')
    || !requestedGuestCapabilities(guest).every((capability) => grants.includes(capability))) {
    throw new LoopbackError(403, 'NOT_GRANTED', 'Loopback access is not approved.');
  }
  if (canonicalizeLoopbackPath(request.path) === null) {
    throw new LoopbackError(400, 'BAD_PATH', 'Invalid loopback path.');
  }
  const path = matchLoopbackRoute(guest.loopback.routes, request.path, request.method);
  if (path === null) throw new LoopbackError(403, 'NOT_GRANTED', 'Loopback route is not approved.');
  return { path, port: target.scope.resolvedPort, scope: target.scope };
};

export const sendLoopbackError = (res, error) => {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof LoopbackError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  // Do not expose filesystem paths, environment values, or upstream credentials.
  console.warn('[guests.loopback] Request failed');
  res.status(502).json({ error: 'HOST_UNAVAILABLE', message: 'Loopback request failed.' });
};
