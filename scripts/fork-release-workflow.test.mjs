import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
const finalize = workflow.jobs['finalize-release'];
const stepOf = (job, name) => workflow.jobs[job].steps.find((step) => step.name === name);

test('a release reaches updaters only once desktop, server and Android are all attached', () => {
  // Updaters read only the latest full release, never a prerelease.
  const create = stepOf('create-release', 'Create GitHub Release');
  assert.equal(create.with.prerelease, true);
  assert.equal(create.with.draft, undefined);

  assert.ok(finalize.needs.includes('mobile-release'));
  const verify = stepOf('finalize-release', 'Verify desktop, server and Android release assets');
  for (const asset of ['-win-x64.exe', '-win-arm64.exe', '-linux-x86_64.AppImage', '-linux-arm64.AppImage', '-linux-amd64.deb', '-linux-x86_64.rpm', '-linux-arm64.deb', '-linux-aarch64.rpm', 'openchamber-web-', 'openchamber-sdk-', '-android.apk']) {
    assert.ok(verify.run.includes(asset), `finalize-release must check for ${asset}`);
  }

  const publish = stepOf('finalize-release', 'Publish release');
  assert.ok(finalize.steps.indexOf(publish) > finalize.steps.indexOf(verify));
  assert.equal(publish.with.prerelease, false);
  assert.equal(publish.if, "${{ github.event.inputs.dry_run != 'true' }}");
});
