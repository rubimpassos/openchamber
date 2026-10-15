import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDownloads } from '../src/downloads.js';

// A downloads folder with Chrome's staging folder in it, as `enable` makes.
const downloadsFolder = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'downloads-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '.partial'));
  return directory;
};

// What Chrome does for one download: announce it, write the staging file, report the end.
const begin = (downloads, directory, guid, suggestedFilename, content) => {
  downloads.event('Browser.downloadWillBegin', { guid, suggestedFilename, url: `https://site.test/${guid}` });
  fs.writeFileSync(path.join(directory, '.partial', guid), content);
};
const end = (downloads, guid, state = 'completed') => {
  downloads.event('Browser.downloadProgress', { guid, state, receivedBytes: 1, totalBytes: 1 });
};

const settled = async (downloads, guids) => {
  const deadline = Date.now() + 2_000;
  while (downloads.list.some((item) => guids.includes(item.id) && item.state === 'downloading')) {
    if (Date.now() > deadline) throw new Error('Downloads never finished');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('keeps two downloads with the same name, and the file already there, each whole', async (context) => {
  // Given a folder that already has report.csv.
  const directory = downloadsFolder(context);
  fs.writeFileSync(path.join(directory, 'report.csv'), 'older');
  const downloads = createDownloads({ directory });

  // When two pages download report.csv and both finish at once.
  begin(downloads, directory, 'a', 'report.csv', 'from a');
  begin(downloads, directory, 'b', 'report.csv', 'from b');
  end(downloads, 'a');
  end(downloads, 'b');
  await settled(downloads, ['a', 'b']);

  // Then every file keeps its own name and content, and no staging file is left.
  assert.equal(fs.readFileSync(path.join(directory, 'report.csv'), 'utf8'), 'older');
  const finished = downloads.list.filter((item) => item.state === 'complete');
  assert.equal(finished.length, 2);
  assert.notEqual(finished[0].path, finished[1].path);
  for (const item of finished) assert.equal(fs.readFileSync(item.path, 'utf8'), `from ${item.id}`);
  assert.deepEqual(fs.readdirSync(path.join(directory, '.partial')), []);
});

test('never forgets a download still running, so it still lands when it ends', async (context) => {
  // Given a long download, then twenty short ones that finish before it.
  const directory = downloadsFolder(context);
  const downloads = createDownloads({ directory });
  begin(downloads, directory, 'long', 'video.mp4', 'long one');
  const short = Array.from({ length: 20 }, (_, index) => `short-${index}`);
  for (const guid of short) begin(downloads, directory, guid, `${guid}.txt`, guid);
  for (const guid of short) end(downloads, guid);
  await settled(downloads, short);

  // Then the running one is still listed, and lands under its name when it ends.
  assert.equal(downloads.list.some((item) => item.id === 'long' && item.state === 'downloading'), true);
  end(downloads, 'long');
  await settled(downloads, ['long']);
  assert.equal(fs.readFileSync(path.join(directory, 'video.mp4'), 'utf8'), 'long one');
  assert.deepEqual(fs.readdirSync(path.join(directory, '.partial')), []);

  // Then the list keeps the twenty most recent once nothing is running.
  assert.equal(downloads.list.length, 20);
});

test('shortens a long name by bytes, keeping its extension, so the file system takes it', async (context) => {
  // Given a site that names its file with 120 CJK characters (360 bytes in UTF-8).
  const directory = downloadsFolder(context);
  const downloads = createDownloads({ directory });
  begin(downloads, directory, 'cjk', `${'報'.repeat(120)}.pdf`, 'pdf bytes');
  end(downloads, 'cjk');
  await settled(downloads, ['cjk']);

  // Then the file lands, under a name the file system accepts, still a .pdf.
  const [item] = downloads.list;
  assert.equal(item.state, 'complete');
  assert.equal(Buffer.byteLength(item.name) <= 200, true);
  assert.equal(item.name.endsWith('.pdf'), true);
  assert.equal(fs.readFileSync(item.path, 'utf8'), 'pdf bytes');
});

test('drops the staging file of a download that fails or is canceled', async (context) => {
  const directory = downloadsFolder(context);
  const downloads = createDownloads({ directory });
  begin(downloads, directory, 'gone', 'gone.zip', 'part');
  begin(downloads, directory, 'stopped', 'stopped.zip', 'part');
  end(downloads, 'gone', 'interrupted');
  end(downloads, 'stopped', 'canceled');
  await settled(downloads, ['gone', 'stopped']);
  assert.deepEqual(downloads.list.map((item) => [item.id, item.state, item.path]), [['stopped', 'canceled', null], ['gone', 'failed', null]]);
  assert.deepEqual(fs.readdirSync(path.join(directory, '.partial')), []);
});
