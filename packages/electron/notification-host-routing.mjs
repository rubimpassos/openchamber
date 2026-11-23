
import { z } from 'zod';

const HOST_RUNTIME_KEY_PREFIX = 'host:';
const URL_RUNTIME_KEY_PREFIX = 'url:';

const LOCAL_HOST_ENTRY_ID = 'local';

const optionalString = z.string().catch('').transform((value) => value.trim());

export const readTrimmedString = (value) => optionalString.parse(value);

const notificationInput = z.union([z.looseObject({}), z.array(z.unknown())]);

// Mirrors the renderer's runtime key normalization (runtime-switch.ts) so a
// URL-bound window's key can be matched back to the host entry its API URL
// came from: hash and search stripped, trailing slash removed, 'url:' prefix.
export const runtimeKeyForHostUrl = (raw) => {
  const trimmed = readTrimmedString(raw);
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    return `${URL_RUNTIME_KEY_PREFIX}${url.toString().replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
};

export const resolveHostEntryForRuntimeKey = (rawKey, { hosts, localUrl, localClientToken }) => {
  const key = readTrimmedString(rawKey);
  if (!key) return null;
  if (key === LOCAL_HOST_ENTRY_ID) {
    if (!localUrl) return null;
    return { id: LOCAL_HOST_ENTRY_ID, url: localUrl, clientToken: localClientToken || '', requestHeaders: {} };
  }
  if (key.startsWith(HOST_RUNTIME_KEY_PREFIX)) {
    const hostId = key.slice(HOST_RUNTIME_KEY_PREFIX.length);
    return (Array.isArray(hosts) ? hosts : []).find((entry) => entry?.id === hostId) || null;
  }
  if (key.startsWith(URL_RUNTIME_KEY_PREFIX)) {
    return (Array.isArray(hosts) ? hosts : []).find((entry) => runtimeKeyForHostUrl(entry?.apiUrl || entry?.url) === key) || null;
  }
  return null;
};

export const findReusableHostWindowIndex = (windows, hostId, { hosts, localUrl, localClientToken }) => {
  let tagMatch = -1;
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (!window) continue;
    const reported = readTrimmedString(window.runtimeKey);
    if (reported) {
      if (resolveHostEntryForRuntimeKey(reported, { hosts, localUrl, localClientToken })?.id === hostId) return index;
      continue;
    }
    if (tagMatch < 0 && readTrimmedString(window.hostWindowId) === hostId) tagMatch = index;
  }
  return tagMatch;
};

export const runtimeKeyForDeepLinkHost = (rawHostId) => {
  const hostId = readTrimmedString(rawHostId);
  if (!hostId) return '';
  return hostId === LOCAL_HOST_ENTRY_ID ? LOCAL_HOST_ENTRY_ID : `${HOST_RUNTIME_KEY_PREFIX}${hostId}`;
};

export const resolveSenderHostId = ({ runtimeKey, hostWindowId }, { hosts, localUrl, localClientToken }) => {
  const reported = readTrimmedString(runtimeKey);
  if (!reported) return readTrimmedString(hostWindowId) || null;
  return resolveHostEntryForRuntimeKey(reported, { hosts, localUrl, localClientToken })?.id || null;
};

export const resolveForwardedNotificationRuntimeKey = ({ runtimeKey, hostWindowId }) => {
  const hostId = readTrimmedString(hostWindowId);
  if (hostId) return runtimeKeyForDeepLinkHost(hostId);
  return readTrimmedString(runtimeKey);
};

export const normalizeNotificationInput = (raw) => {
  const input = notificationInput.catch({}).parse(raw);
  const payload = notificationInput.safeParse(input.payload);
  return payload.success ? { ...input, ...payload.data } : input;
};

const linkId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const notificationOpenTargetSchema = z.object({
  sessionId: optionalString, directory: optionalString, guestId: optionalString, runtimeKey: optionalString,
  botTarget: z.object({ projectId: linkId, itemId: linkId }).strict().optional(),
});

/** Only structured navigation fields cross to a renderer or saved-host window. */
export const parseNotificationOpenTarget = (raw) => {
  const result = notificationOpenTargetSchema.safeParse(raw);
  if (!result.success) return null;
  const { sessionId, directory, guestId, runtimeKey, botTarget } = result.data;
  if (!sessionId && !botTarget) return null;
  const target = {};
  if (sessionId) Object.assign(target, { sessionId, directory: directory || null, guestId: guestId || null });
  if (runtimeKey) target.runtimeKey = runtimeKey;
  if (botTarget) target.botTarget = botTarget;
  return target;
};

// Builds the notification input for a renderer-forwarded desktop_notify:
// flatten the wrapped payload, strip the nested copy, and stamp the runtime
// key with the forwarding window's tag taking precedence. Stripping the
// nested payload matters: maybeShowNativeNotification normalizes again, and
// a surviving nested runtimeKey would shadow the stamp.
export const stampForwardedNotification = (rawInput, hostWindowId) => {
  const { payload: _nested, ...flat } = normalizeNotificationInput(rawInput);
  return {
    ...flat,
    runtimeKey: resolveForwardedNotificationRuntimeKey({
      runtimeKey: flat.runtimeKey,
      hostWindowId,
    }),
  };
};
