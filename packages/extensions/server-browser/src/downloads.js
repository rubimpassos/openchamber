import fs from 'node:fs';
import path from 'node:path';

// Files pages download. Headless Chrome drops them unless told where to put
// them, so each browser writes into `directory` (the chat's project, under
// .openchamber/downloads, where the agent can use them): Chrome fills a
// staging file named by its id, and a finished file is moved next to it under
// the name the site gave. The person saves a copy on their own device from
// the panel; the file stays here.

const LIST_MAX = 20;
// Bytes, not characters: file systems allow 255 bytes a name, and UTF-8 takes
// up to four a character. This leaves room for " (12)" before the extension.
const NAME_MAX_BYTES = 200;
const EXTENSION_MAX_BYTES = 20;
const NAME_ATTEMPTS_MAX = 1_000;
const URL_MAX = 2_000;
// Progress reaches the dock state, which every viewer polls; once a second is plenty.
const PROGRESS_STEP_MS = 1_000;

const UNSAFE_NAME_CHARACTERS = new Set(['<', '>', ':', '"', '|', '?', '*']);

const byteLength = (text) => Buffer.byteLength(text, 'utf8');

// Shortened a whole character at a time, keeping the extension.
const fitName = (name) => {
  if (byteLength(name) <= NAME_MAX_BYTES) return name;
  const extension = path.extname(name);
  const kept = byteLength(extension) <= EXTENSION_MAX_BYTES ? extension : '';
  const stem = Array.from(name.slice(0, name.length - kept.length));
  while (stem.length > 0 && byteLength(stem.join('') + kept) > NAME_MAX_BYTES) stem.pop();
  return stem.join('') + kept;
};

const safeName = (value) => {
  const base = path.basename(String(value ?? '').replace(/\\/g, '/'));
  const cleaned = Array.from(base, (character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127 || UNSAFE_NAME_CHARACTERS.has(character) ? '_' : character;
  }).join('').replace(/^\.+/, '').trim();
  return fitName(cleaned) || 'download';
};

// Puts the staged file under the first name free in `directory` and returns
// that path: report.pdf, then report (1).pdf. It never replaces a file, even
// one another download or the agent writes meanwhile: a hard link fails on a
// name that exists (the commit /api/fs/upload uses), and where the file
// system has no hard links an exclusive copy does the same.
const commitUnder = async (source, directory, name) => {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let attempt = 0; attempt < NAME_ATTEMPTS_MAX; attempt += 1) {
    const candidate = path.join(directory, attempt === 0 ? name : `${stem} (${attempt})${extension}`);
    try {
      await fs.promises.link(source, candidate).catch((error) => {
        if (error?.code === 'EEXIST' || error?.code === 'ENOENT') throw error;
        return fs.promises.copyFile(source, candidate, fs.constants.COPYFILE_EXCL);
      });
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    await fs.promises.rm(source, { force: true });
    return candidate;
  }
  throw new Error(`No free name for ${name}`);
};

export const createDownloads = ({ directory, now = Date.now }) => {
  const staging = path.join(directory, '.partial');
  const items = new Map();

  // Only finished downloads are forgotten: one still running must still be
  // moved into place (or its staging file removed) when it ends.
  const forgetOldest = () => {
    for (const [id, item] of items) {
      if (items.size <= LIST_MAX) return;
      if (item.state !== 'downloading') items.delete(id);
    }
  };

  // The state changes once the file is in place, or its staging file gone.
  const finish = async (item, state) => {
    const stagingPath = path.join(staging, item.id);
    let outcome = state;
    if (outcome === 'complete') {
      try {
        const target = await commitUnder(stagingPath, directory, item.name);
        item.path = target;
        item.name = path.basename(target);
      } catch {
        outcome = 'failed';
      }
    }
    if (outcome !== 'complete') await fs.promises.rm(stagingPath, { force: true }).catch(() => {});
    item.state = outcome;
    forgetOldest();
  };

  return {
    /** Lets Chrome download into this folder; `browserContextId` null is Chrome's default context. */
    async enable(cdp, browserContextId) {
      await fs.promises.mkdir(staging, { recursive: true });
      // Copies of other sites' files never belong in the project's history.
      await fs.promises.writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => {
        if (error?.code !== 'EEXIST') throw error;
      });
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: staging,
        eventsEnabled: true,
        ...(browserContextId ? { browserContextId } : {}),
      });
    },

    event(method, params) {
      if (method === 'Browser.downloadWillBegin' && typeof params?.guid === 'string') {
        items.set(params.guid, {
          id: params.guid,
          name: safeName(params.suggestedFilename),
          url: String(params.url ?? '').slice(0, URL_MAX),
          state: 'downloading',
          receivedBytes: 0,
          totalBytes: null,
          path: null,
          reportedAt: 0,
        });
        forgetOldest();
        return;
      }
      if (method !== 'Browser.downloadProgress') return;
      const item = items.get(params?.guid);
      if (!item || item.state !== 'downloading' || item.finishing) return;
      if (Number.isFinite(params.totalBytes) && params.totalBytes > 0) item.totalBytes = params.totalBytes;
      if (params.state === 'inProgress') {
        if (now() - item.reportedAt >= PROGRESS_STEP_MS && Number.isFinite(params.receivedBytes)) {
          item.receivedBytes = params.receivedBytes;
          item.reportedAt = now();
        }
        return;
      }
      if (Number.isFinite(params.receivedBytes)) item.receivedBytes = params.receivedBytes;
      // Kept 'downloading' until the file is in place, so a path is never
      // reported for a file that is not there yet; finished once only.
      item.finishing = true;
      void finish(item, params.state === 'completed' ? 'complete' : params.state === 'canceled' ? 'canceled' : 'failed');
    },

    /** Newest first; `path` is set once the file is complete. */
    get list() {
      return [...items.values()].reverse().map(({ id, name, url, state, receivedBytes, totalBytes, path: filePath }) => ({
        id, name, url, state, receivedBytes, totalBytes, path: filePath,
      }));
    },

    /** Unfinished downloads die with Chrome; their staging files go too. */
    async close() {
      await Promise.all([...items.values()]
        .filter((item) => item.state === 'downloading' && !item.finishing)
        .map((item) => fs.promises.rm(path.join(staging, item.id), { force: true }).catch(() => {})));
    },
  };
};
