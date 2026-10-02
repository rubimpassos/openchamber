import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyTurbo2DataDir, resolveTurbo2DataDir, seedTurbo2DataDir } from './turbo2-data-dir.mjs';

const makeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-turbo2-'));

test('defaults to its own directory beside the v1 data directory', () => {
  const homeDir = makeHome();
  assert.deepEqual(resolveTurbo2DataDir({ environment: {}, homeDir }), {
    dataDir: path.join(homeDir, '.config', 'openchamber-turbo2'),
    owned: true,
  });
});

test('an explicit OPENCHAMBER_DATA_DIR wins and is left untouched', () => {
  const homeDir = makeHome();
  const environment = { OPENCHAMBER_DATA_DIR: '/custom/dir' };
  assert.equal(applyTurbo2DataDir({ environment, homeDir }), '/custom/dir');
  assert.equal(environment.OPENCHAMBER_DATA_DIR, '/custom/dir');
  assert.equal(fs.existsSync(path.join(homeDir, '.config', 'openchamber-turbo2')), false);
});

test('first run copies v1 settings and never modifies the v1 files', () => {
  const homeDir = makeHome();
  const legacy = path.join(homeDir, '.config', 'openchamber');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"desktopHosts":[]}');
  fs.writeFileSync(path.join(legacy, 'preferences.json'), '{"a":1}');
  fs.writeFileSync(path.join(legacy, 'other.json'), '{}');

  const environment = {};
  const dataDir = applyTurbo2DataDir({ environment, homeDir });

  assert.equal(environment.OPENCHAMBER_DATA_DIR, dataDir);
  assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), '{"desktopHosts":[]}');
  assert.equal(fs.readFileSync(path.join(dataDir, 'preferences.json'), 'utf8'), '{"a":1}');
  assert.equal(fs.existsSync(path.join(dataDir, 'other.json')), false);

  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"migrated":true}');
  assert.equal(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8'), '{"desktopHosts":[]}');
});

test('an existing Turbo 2 directory is never re-seeded', () => {
  const homeDir = makeHome();
  const dataDir = path.join(homeDir, '.config', 'openchamber-turbo2');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"mine":true}');
  fs.mkdirSync(path.join(homeDir, '.config', 'openchamber'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'openchamber', 'settings.json'), '{"v1":true}');

  assert.equal(seedTurbo2DataDir({ dataDir, homeDir }), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), '{"mine":true}');
});
