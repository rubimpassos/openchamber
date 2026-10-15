import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPageRequests } from '../src/page-requests.js';

const newTab = () => ({ dialog: null, fileChooser: null, dialogListeners: new Set() });

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('answers a dialog once when two answers arrive together, and lets a failed answer be retried', async () => {
  // Given a tab whose page opened an alert, and a Chrome that closes it when answered.
  const requests = createPageRequests();
  const tab = newTab();
  requests.dialogOpened(tab, { type: 'confirm', message: 'Delete the draft?' });
  const sent = [];
  const send = async (method, params) => {
    sent.push([method, params]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    requests.dialogClosed(tab);
  };

  // When two viewers press OK and Cancel at the same moment.
  const first = requests.answerDialog(tab, send, { dialogId: tab.dialog.id, accept: true });
  const second = requests.answerDialog(tab, send, { dialogId: tab.dialog.id, accept: false });

  // Then only the first reaches Chrome; the second is told the dialog is gone.
  await assert.rejects(second, /no longer open/);
  assert.deepEqual(await first, { answered: { type: 'confirm', message: 'Delete the draft?' }, accepted: true });
  assert.deepEqual(sent, [['Page.handleJavaScriptDialog', { accept: true }]]);

  // When Chrome fails an answer for another reason, then the same dialog can be answered again.
  requests.dialogOpened(tab, { type: 'alert', message: 'Saved' });
  let failing = true;
  const flaky = async () => {
    if (failing) {
      failing = false;
      throw new Error('CDP command Page.handleJavaScriptDialog failed: timed out');
    }
    requests.dialogClosed(tab);
  };
  await assert.rejects(requests.answerDialog(tab, flaky, { accept: true }), /timed out/);
  assert.deepEqual((await requests.answerDialog(tab, flaky, { accept: true })).answered, { type: 'alert', message: 'Saved' });
});

test('drops a file request whose page went away while it was being prepared', async (context) => {
  // Given a browser with somewhere to put files, and a page that navigates while its chooser is read.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-requests-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = createPageRequests({ uploadRoot: path.join(root, 'uploads') });
  const tab = newTab();
  let releaseRead;
  const send = (method) => (method === 'DOM.resolveNode'
    ? new Promise((resolve) => { releaseRead = () => resolve({ object: null }); })
    : Promise.resolve({}));

  // When the chooser opens and the document is replaced before it is ready.
  const opening = requests.fileChooserOpened(tab, { mode: 'selectSingle', backendNodeId: 7 }, send);
  await waitFor(() => typeof releaseRead === 'function');
  requests.navigated(tab);
  releaseRead();
  await opening;

  // Then no request is shown for the input that is gone, and its folder is not left behind.
  assert.equal(tab.fileChooser, null);
  await waitFor(() => {
    const browserFolders = fs.readdirSync(path.join(root, 'uploads')).filter((name) => name !== '.gitignore');
    return browserFolders.every((folder) => fs.readdirSync(path.join(root, 'uploads', folder)).length === 0);
  });

  // When the next document's chooser opens undisturbed, then it is held as usual.
  await requests.fileChooserOpened(tab, { mode: 'selectMultiple', backendNodeId: 9 }, () => Promise.resolve({ object: null }));
  assert.equal(tab.fileChooser?.mode, 'selectMultiple');
  assert.equal(fs.existsSync(tab.fileChooser.directory), true);
  await requests.close();
});
