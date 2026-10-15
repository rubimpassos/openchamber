import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// What a page asks of the person: a JavaScript dialog (alert, confirm, prompt,
// "leave this page?"), which pauses the page until it is answered, and a file
// chooser, which waits for files. Headless Chrome shows neither, so the
// runtime keeps them on the tab and the dock or the agent answers them.

const DIALOG_TYPES = new Set(['alert', 'confirm', 'prompt', 'beforeunload']);
const MESSAGE_MAX = 2_000;
const ACCEPT_MAX = 500;
const CHOOSER_MODES = new Set(['selectSingle', 'selectMultiple']);
// After an answer the page runs again and may open the next dialog at once.
const NEXT_DIALOG_WAIT_MS = 250;
const DIALOG_CLOSE_WAIT_MS = 2_000;

const bounded = (value, maximum) => String(value ?? '').slice(0, maximum);

/** A dialog as the dock and the agent see it. */
export const publicDialog = (dialog) => ({
  type: dialog.type,
  message: dialog.message,
  ...(dialog.type === 'prompt' ? { defaultPrompt: dialog.defaultPrompt } : {}),
});

const describeDialog = (dialog) => {
  if (dialog.type === 'beforeunload') return 'a "leave this page?" dialog';
  const text = dialog.message ? `: "${dialog.message}"` : '';
  return `${dialog.type === 'alert' ? 'an alert' : `a ${dialog.type} dialog`}${text}`;
};

const howToAnswer = (dialog) => {
  if (dialog.type === 'alert') return 'Close it with browser.dialog (accept true).';
  if (dialog.type === 'beforeunload') return 'Answer it with browser.dialog: accept true leaves the page, false stays on it.';
  if (dialog.type === 'prompt') return 'Answer it with browser.dialog: accept true with promptText submits that text, false cancels it.';
  return 'Answer it with browser.dialog: accept true presses OK, false presses Cancel.';
};

/**
 * Read by the agent: a dialog pauses the page, so actions on its tab fail
 * naming it instead of waiting on a page that cannot run.
 */
export const dialogBlockedMessage = (dialog, { during = false } = {}) => (during
  ? `The page opened ${describeDialog(dialog)} while this action ran, and it is paused until the dialog is answered. ${howToAnswer(dialog)} Whatever the action did before the dialog opened has happened; read the page again after answering before repeating it.`
  : `This tab has ${describeDialog(dialog)} open, and the page is paused until it is answered, so it cannot be read or used. ${howToAnswer(dialog)}`);

/**
 * `uploadRoot` is where files a person picks for a page are put; without one,
 * file choosers are left to Chrome, which shows none. Every tab passed in
 * carries `dialog`, `fileChooser`, and a `dialogListeners` set.
 */
export const createPageRequests = ({ uploadRoot = null } = {}) => {
  let sequence = 0;
  // Bumped per tab when its document goes away, so a file request still
  // being prepared for the old document is dropped.
  const documents = new WeakMap();
  const documentOf = (tab) => documents.get(tab) ?? 0;
  const nextDocument = (tab) => documents.set(tab, documentOf(tab) + 1);
  // This browser's own folder under the upload root, so browsers of other
  // chats in the same project never see or remove each other's files.
  const uploadFolder = uploadRoot ? path.join(uploadRoot, crypto.randomBytes(6).toString('hex')) : null;
  let uploadFolderReady = null;

  const ensureUploadFolder = () => {
    if (!uploadFolderReady) {
      uploadFolderReady = (async () => {
        await fs.promises.mkdir(uploadFolder, { recursive: true });
        // The files are the person's, copied here for one page; they never
        // belong in the project's history.
        await fs.promises.writeFile(path.join(uploadRoot, '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => {
          if (error?.code !== 'EEXIST') throw error;
        });
      })().catch((error) => {
        uploadFolderReady = null;
        throw error;
      });
    }
    return uploadFolderReady;
  };

  const notify = (tab) => {
    for (const listener of [...tab.dialogListeners]) listener();
  };

  const removeChooserFolder = (chooser) => {
    if (chooser?.directory && !chooser.used) void fs.promises.rm(chooser.directory, { recursive: true, force: true }).catch(() => {});
  };

  const dialogOpened = (tab, params) => {
    sequence += 1;
    tab.dialog = {
      id: sequence,
      type: DIALOG_TYPES.has(params?.type) ? params.type : 'alert',
      message: bounded(params?.message, MESSAGE_MAX),
      defaultPrompt: bounded(params?.defaultPrompt, MESSAGE_MAX),
    };
    notify(tab);
  };

  const dialogClosed = (tab) => {
    tab.dialog = null;
    notify(tab);
  };

  /** Resolves on the tab's next dialog change, or after `timeoutMs`. */
  const waitForDialogChange = (tab, timeoutMs) => new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      tab.dialogListeners.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    tab.dialogListeners.add(done);
  });

  /**
   * Presses OK or Cancel on the tab's dialog. A `dialogId` names the dialog
   * the dock showed, so a click on an earlier one never answers the next.
   * OK on a prompt with no `promptText` submits the text the page proposed.
   */
  const answerDialog = async (tab, send, { dialogId = null, accept, promptText }) => {
    const dialog = tab.dialog;
    // A dialog already being answered (two viewers, or a viewer and the
    // agent, at once) is not answered twice: the second command would land
    // on the next dialog the page opens.
    if (!dialog || dialog.answering || (dialogId !== null && dialog.id !== dialogId)) throw new Error('That dialog is no longer open');
    dialog.answering = true;
    const closed = waitForDialogChange(tab, DIALOG_CLOSE_WAIT_MS);
    try {
      await send('Page.handleJavaScriptDialog', {
        accept,
        ...(dialog.type === 'prompt' && accept ? { promptText: typeof promptText === 'string' ? promptText : dialog.defaultPrompt } : {}),
      });
    } catch (error) {
      // Chrome closed it some other way: the tab navigated or closed.
      if (/no dialog/i.test(String(error?.message))) {
        if (tab.dialog === dialog) dialogClosed(tab);
        throw new Error('That dialog is no longer open');
      }
      dialog.answering = false;
      throw error;
    }
    await closed;
    if (tab.dialog === dialog) dialogClosed(tab);
    if (!tab.dialog) await waitForDialogChange(tab, NEXT_DIALOG_WAIT_MS);
    return { answered: publicDialog(dialog), accepted: accept };
  };

  const fileChooserOpened = async (tab, params, send) => {
    if (!uploadFolder || !CHOOSER_MODES.has(params?.mode) || !Number.isInteger(params?.backendNodeId)) return;
    sequence += 1;
    const id = sequence;
    const documentAtOpen = documentOf(tab);
    // What the input accepts, shown to the person as a hint; the page checks
    // the files itself, as it would with any browser's chooser.
    let accept = '';
    try {
      const { object } = await send('DOM.resolveNode', { backendNodeId: params.backendNodeId });
      if (object?.objectId) {
        const read = await send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function () { return String(this.accept || ""); }',
          returnByValue: true,
        });
        accept = bounded(read?.result?.value, ACCEPT_MAX);
        await send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      }
    } catch {}
    await ensureUploadFolder();
    const directory = path.join(uploadFolder, String(id));
    await fs.promises.mkdir(directory, { recursive: true });
    const chooser = { id, mode: params.mode, accept, backendNodeId: params.backendNodeId, directory, used: false };
    // The page navigated (or the tab closed) meanwhile: its input is gone.
    if (documentOf(tab) !== documentAtOpen) {
      removeChooserFolder(chooser);
      return;
    }
    removeChooserFolder(tab.fileChooser);
    tab.fileChooser = chooser;
  };

  /**
   * Gives the page the files the person put in the chooser's folder, or none
   * for a cancel (`files` null). Names are plain file names in that folder.
   */
  const answerFileChooser = async (tab, send, { chooserId, files = null }) => {
    const chooser = tab.fileChooser;
    if (!chooser || chooser.id !== chooserId) throw new Error('That file request is no longer open');
    if (files === null) {
      tab.fileChooser = null;
      removeChooserFolder(chooser);
      await send('DOM.setFileInputFiles', { files: [], backendNodeId: chooser.backendNodeId }).catch(() => {});
      return;
    }
    if (files.length === 0) throw new Error('Choose at least one file');
    if (chooser.mode === 'selectSingle' && files.length > 1) throw new Error('This page takes one file');
    const paths = [];
    for (const name of files) {
      if (typeof name !== 'string' || name.length === 0 || name !== path.basename(name) || name === '.' || name === '..') {
        throw new Error('File names must be plain names in the upload folder');
      }
      const target = path.join(chooser.directory, name);
      const stat = await fs.promises.lstat(target).catch(() => null);
      if (!stat?.isFile()) throw new Error(`${name} was not uploaded`);
      paths.push(target);
    }
    await send('DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
    chooser.used = true;
    if (tab.fileChooser === chooser) tab.fileChooser = null;
  };

  return {
    /** Chrome intercepts file choosers only for a browser that has somewhere to put the files. */
    interceptsFileChoosers: Boolean(uploadFolder),
    dialogOpened,
    dialogClosed,
    waitForDialogChange,
    answerDialog,
    fileChooserOpened,
    answerFileChooser,
    /** A new document: its file input is gone. */
    navigated(tab) {
      nextDocument(tab);
      removeChooserFolder(tab.fileChooser);
      tab.fileChooser = null;
    },
    forget(tab) {
      nextDocument(tab);
      removeChooserFolder(tab.fileChooser);
      tab.fileChooser = null;
      if (tab.dialog) dialogClosed(tab);
    },
    /** The files pages were given stay until this browser closes. */
    async close() {
      if (uploadFolder) await fs.promises.rm(uploadFolder, { recursive: true, force: true }).catch(() => {});
    },
  };
};
