import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createExecutor } from './exec.js';
import { layout } from './state.js';
import { SPACE_CONNECT_COMMAND } from '../spaces/layout.js';

// The system boundary is a stand-in: these tests never spawn or call systemd.
function fixture(result = 'ExecMainCode=1\nExecMainStatus=7\n') {
  const paths = layout('/unused-hostd-test');
  const record = { id: '123456abcdef', place: 'host', toolsKey: '1234567890abcdef', memoryBytes: 1024, startConfig: null };
  const invocations = [];
  const system = {
    async run(file, args) {
      invocations.push({ file, args });
      return { code: 0, stdout: args.includes(`openchamber-space-${record.id}.service`)
        ? `ActiveState=active\nReadOnlyPaths=${paths.spaceState}/${record.id} ${paths.privateState}/${record.id}\n`
        : result, stderr: '' };
    },
    spawn(file, args) {
      invocations.push({ file, args });
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        const marker = args.find((value) => value.startsWith('hostd-started-'));
        child.stdout.end(Buffer.from([0, 255, 65]));
        child.stderr.write(`${marker}\n`.slice(0, 9));
        child.stderr.end(`${marker}\n`.slice(9) + 'diagnostic');
        child.emit('close', 0, null);
      });
      return child;
    },
  };
  const executor = createExecutor({ system, paths, state: { requireRecord: async () => record } });
  const request = { op: 'exec', place: record.place, id: record.id, target: 'space', argv: ['/usr/bin/printf', 'value'], timeoutMs: 1000, maxOutputBytes: 1024, keepTail: false };
  return { executor, request, invocations };
}

describe('hostd executor without privileged operations', () => {
  it('streams binary output without the startup marker when the runner finishes', async () => {
    // Given a system runner that emits binary output and a split startup marker.
    const { executor, request } = fixture();
    const stdout = [];
    const stderr = [];
    // When executing through the production stream pump.
    const code = await executor.run(request, { stdin: [], stdout: async (chunk) => { stdout.push(chunk); }, stderr: async (chunk) => { stderr.push(chunk); } });
    // Then bytes survive, the internal marker is absent and the inspected exit wins.
    expect({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() })
      .toEqual({ code: 7, stdout: Buffer.from([0, 255, 65]), stderr: 'diagnostic' });
  });

  it('uses the successful wait when the finished transient unit has been collected', async () => {
    // Given a successful runner whose transient unit no longer exists.
    const { executor, request } = fixture('LoadState=not-found\n');
    // When collecting the command output.
    const result = await executor.collect(request, 'input');
    // Then success and decoded output remain available.
    expect(result).toEqual({ code: 0, stdout: Buffer.from([0, 255, 65]).toString('utf8'), stderr: 'diagnostic' });
  });

  it('uses the shared bridge argv when attach omits a command', async () => {
    // Given an attach request with no argv.
    const { executor, request, invocations } = fixture();
    // When attaching through the same executor.
    await executor.collect({ op: 'attach', place: request.place, id: request.id });
    // Then the fixed launcher receives the unchanged bridge command.
    const spawn = invocations.find(({ file }) => file === '/usr/bin/systemd-run');
    expect(spawn.args.slice(-SPACE_CONNECT_COMMAND.length)).toEqual(SPACE_CONNECT_COMMAND);
  });
});
