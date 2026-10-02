// Per-site cookie listing and wipe for a saved profile's sites page
// (`GET /profiles/sites`, `POST /profiles/sites/clear`). Unlike a chat's
// browser, there is no live scope here: each call checks out its own copy
// of the profile and launches a dedicated headless Chrome on it with no page
// and no network proxy (nothing here navigates anywhere; Storage/Network
// commands work against the profile's cookie jar and site storage without
// one). A listing discards its copy unchanged; a clear closes Chrome first
// so its cookie jar is flushed, exactly like a chat's browser closing with
// `save: true`, then checks the copy in and discards it.
import fs from 'node:fs';
import { connectCdp } from './cdp-client.js';
import { createChromeProcess } from './chrome-process.js';

const normalizeDomain = (value) => String(value ?? '').replace(/^\./, '').trim().toLowerCase();

const discard = (directory) => fs.promises.rm(directory, { recursive: true, force: true });

const listSitesFrom = async (cdp) => {
  const { cookies } = await cdp.send('Storage.getCookies');
  const counts = new Map();
  for (const cookie of cookies ?? []) {
    const domain = normalizeDomain(cookie.domain);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, cookies: count }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
};

// Runs `operation` against a dedicated Chrome on a checked-out copy, closes
// that Chrome (so anything it still owed to disk is flushed), and returns
// the operation's result alongside the copy's directory and the version it
// was taken at. The copy itself is this function's caller's to discard or
// check in; closing Chrome first and discarding or checking in after keeps
// every filesystem operation on the copy outside the running process.
const withCheckedOutChrome = async (profile, chromePath, operation) => {
  const { directory, version } = await profile.checkout();
  const chrome = createChromeProcess({ chromePath, userDataDir: directory });
  try {
    const running = await chrome.ensure();
    const cdp = await connectCdp(running.endpoint);
    let value;
    try {
      value = await operation({ cdp, directory, version });
    } finally {
      cdp.close();
    }
    return { value, directory, version };
  } finally {
    await chrome.close();
  }
};

/** `{ domain, cookies }[]`, one entry per distinct cookie domain, sorted. */
export const listProfileSites = async (profile, { chromePath = null } = {}) => {
  const { value, directory } = await withCheckedOutChrome(profile, chromePath, ({ cdp }) => listSitesFrom(cdp));
  // A listing changes nothing in the profile; the copy is thrown away rather than checked in.
  await discard(directory);
  return value;
};

/**
 * Removes one site's cookies and storage from the saved profile (a new
 * version; a copy taken before this sees a stale save as usual) and
 * answers the sites list as it stands right after. Nothing matching the
 * domain is not an error: the copy still checks in, so a concurrent save
 * conflict surfaces exactly as it would for any other change.
 */
// `Network.deleteCookies` needs an attached page session in this Chrome
// version; `Storage.*` cookie commands do not, and this module otherwise
// never attaches one (no page, no navigation). Removing one site's cookies
// at the browser level is therefore clear-everything-then-restore-the-rest,
// not a per-cookie delete.
const COOKIE_PARAM_KEYS = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires', 'priority', 'sameParty', 'partitionKey'];

const asCookieParam = (cookie) => Object.fromEntries(
  COOKIE_PARAM_KEYS.filter((key) => cookie[key] !== undefined).map((key) => [key, cookie[key]]),
);

export const clearProfileSite = async (profile, domain, { chromePath = null } = {}) => {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error('domain is required');
  const { value: sites, directory, version } = await withCheckedOutChrome(profile, chromePath, async ({ cdp }) => {
    const { cookies } = await cdp.send('Storage.getCookies');
    const kept = (cookies ?? []).filter((cookie) => normalizeDomain(cookie.domain) !== normalized);
    await cdp.send('Storage.clearCookies');
    if (kept.length > 0) await cdp.send('Storage.setCookies', { cookies: kept.map(asCookieParam) });
    for (const origin of [`https://${normalized}`, `http://${normalized}`]) {
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => {});
    }
    return listSitesFrom(cdp);
  });
  try {
    const newVersion = await profile.checkin(directory, version);
    return { version: newVersion, sites };
  } finally {
    await discard(directory);
  }
};
