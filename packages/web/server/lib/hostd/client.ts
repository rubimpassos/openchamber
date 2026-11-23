import net from 'node:net';
import { hasProperties } from '../shared/guards.js';
import { SpaceError } from '../spaces/errors.js';
import { connectionError, remoteError } from './client-errors.js';
import { HostdStream } from './client-stream.js';
import type { HostdAttachRequest, HostdExecOptions, HostdExecRequest, HostdExecResult, HostdRequest, HostdRequestOptions } from './contracts.js';
import { FRAME, MAX_FRAME_BYTES, FrameDecoder, controlFrame, frame, parseControl } from './protocol.js';
import type { HostdFrame } from './protocol.js';

export const DEFAULT_SOCKET = '/run/openchamber-hostd/hostd.sock';

// The collecting window has a head while trimming. Keep its original failure if that invariant breaks.
const firstChunk = (chunks: readonly Buffer[]): Buffer => {
  const chunk = chunks[0];
  if (chunk === undefined) throw new TypeError("Cannot read properties of undefined (reading 'length')");
  return chunk;
};

export function createHostdClient({ socketPath = DEFAULT_SOCKET }: { readonly socketPath?: string | undefined } = {}) {
  function open(request: HostdRequest, options: HostdRequestOptions & { readonly stream: true }): Promise<HostdStream>;
  function open(request: HostdRequest, options?: HostdRequestOptions): Promise<unknown>;
  function open(request: HostdRequest, { stream = false, input, timeoutMs = 35 * 60_000 }: HostdRequestOptions & { readonly stream?: boolean } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const decoder = new FrameDecoder();
      let answered = false;
      const fail = (error: unknown): void => { socket.destroy(); decoder.destroy(); reject(error); };
      const connectError = (error: NodeJS.ErrnoException): void => fail(connectionError(error));
      socket.on('error', connectError);
      decoder.on('error', fail);
      const handshakeTimeout = (): void => fail(new SpaceError('hostd_timeout', 'hostd did not answer in time'));
      socket.setTimeout(timeoutMs, handshakeTimeout);
      socket.once('close', () => { if (!answered) fail(new SpaceError('hostd_disconnected', 'hostd closed before answering')); });
      socket.pipe(decoder);
      decoder.once('data', ({ type, payload }: HostdFrame) => {
        try {
          if (type !== FRAME.CONTROL) throw new SpaceError('hostd_answer_unreadable', 'hostd did not answer with a control frame');
          const answer = parseControl(payload);
          if (!hasProperties(answer) || answer.ok !== true) throw remoteError(answer ?? {});
          answered = true;
          // An idle timeout later set by the HTTP agent must not end the handshake again.
          socket.setTimeout(0, handshakeTimeout);
          if (stream) {
            socket.removeListener('error', connectError);
            decoder.removeListener('error', fail);
            resolve(new HostdStream(socket, decoder));
          } else { socket.destroy(); resolve(answer.result); }
        } catch (error) { fail(error); }
      });
      socket.once('connect', () => {
        socket.write(controlFrame(request));
        if (input !== undefined) {
          let offset = 0;
          const next = (): void => {
            if (offset === input.length) { socket.write(frame(FRAME.STDIN_END)); return; }
            const end = Math.min(offset + MAX_FRAME_BYTES, input.length);
            const bytes = input.subarray(offset, end);
            offset = end;
            socket.write(frame(FRAME.STDIN, bytes), (error) => error ? fail(connectionError(error)) : next());
          };
          next();
        }
      });
    });
  }
  return {
    socketPath,
    // A successful control envelope does not check the operation-specific result's shape.
    request: (request: HostdRequest, options?: HostdRequestOptions): Promise<unknown> => open(request, options),
    attach: (request: HostdAttachRequest): Promise<HostdStream> => open(request, { stream: true, timeoutMs: 60_000 }),
    exec: async (request: HostdExecRequest, { stdin = '', signal }: HostdExecOptions = {}): Promise<HostdExecResult> => {
      if (signal?.aborted) throw new SpaceError('command_aborted', 'The command was stopped by its caller');
      const channel = await open(request, { stream: true, timeoutMs: 60_000 });
      const stdout: Buffer[] = [];
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutBytes = 0;
      const max = request.maxOutputBytes ?? 4 * 1024 * 1024;
      const abort = (): void => { channel.destroy(new SpaceError('command_aborted', 'The command was stopped by its caller')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      channel.on('stderr', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-max); });
      channel.end(stdin);
      try {
        for await (const chunk of channel) {
          stdout.push(chunk); stdoutBytes += chunk.length;
          while (stdout.length > 1 && stdoutBytes - firstChunk(stdout).length >= max) {
            stdoutBytes -= firstChunk(stdout).length;
            stdout.shift();
          }
          if (stdoutBytes > max) { stdout[0] = firstChunk(stdout).subarray(stdoutBytes - max); stdoutBytes = max; }
        }
        if (channel.exitCode === undefined) throw new SpaceError('hostd_disconnected', 'hostd disconnected before the command ended');
        return { code: channel.exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderr.toString('utf8') };
      } finally { signal?.removeEventListener('abort', abort); channel.destroy(); }
    },
  };
}
