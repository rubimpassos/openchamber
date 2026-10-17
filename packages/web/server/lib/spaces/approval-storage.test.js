import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('approval body storage', () => {
  it('bounds retained allocation overhead when an upload arrives in tiny fragments', () => {
    // Given the production reader in its own Node process with explicit collection for measurement.
    const program = fileURLToPath(new URL('./gatekeeper-program.cjs', import.meta.url));
    const probe = `
      const { EventEmitter } = require('node:events');
      const { createApprovalBodies } = require(process.argv[1]);
      const bodies = createApprovalBodies({ maximum: 1024 * 1024, total: 1024 * 1024 });
      const request = new EventEmitter();
      request.pause = () => {};
      global.gc();
      const baseline = process.memoryUsage();
      const reservation = bodies.acquire();
      const reading = reservation.read(request);
      for (let index = 0; index < 65536; index += 1) request.emit('data', Buffer.from('xxxxxxxxxxxxxxxx'));
      global.gc();
      const retained = process.memoryUsage();
      const active = bodies.inspect();
      request.emit('aborted');
      reading.then(() => process.stdout.write(JSON.stringify({ baseline, retained, active, released: bodies.inspect() })));
    `;
    // When one admitted 1 MiB upload is delivered as 65,536 distinct 16-byte fragments.
    const child = spawnSync(process.execPath, ['--expose-gc', '-e', probe, program], { encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    process.stdout.write(`${JSON.stringify({ control: 'fragmented-body', ...result })}\n`);
    // Then byte storage stays bounded without retaining one Buffer wrapper per fragment.
    expect(result.active).toMatchObject({ active: 1, reservedBytes: 1024 * 1024, bufferedBytes: 1024 * 1024 });
    expect(result.retained.heapUsed - result.baseline.heapUsed).toBeLessThan(2 * 1024 * 1024);
    expect(result.released).toMatchObject({ active: 0, reservedBytes: 0, bufferedBytes: 0 });
  });
});
