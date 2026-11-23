import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { hasProperties } from '../shared/guards.js';
import { SpaceError } from '../spaces/errors.js';
import { connectionError, remoteError } from './client-errors.js';
import { FRAME, MAX_FRAME_BYTES, FrameDecoder, frame, parseControl } from './protocol.js';
import type { HostdFrame } from './protocol.js';

export class HostdStream extends Duplex {
  readonly #socket: Socket;
  readonly #decoder: FrameDecoder;
  #finished = false;
  #stderr: Buffer = Buffer.alloc(0);
  // The HTTP agent sets these on its socket-like channel; exit arrives from hostd.
  bridge?: boolean;
  exitCode?: number;
  timeout?: number;

  constructor(socket: Socket, decoder: FrameDecoder) {
    super({ allowHalfOpen: false });
    // Acceptance and first output may share one chunk. Wait for the caller's listeners.
    decoder.pause();
    this.#socket = socket;
    this.#decoder = decoder;
    this.on('error', () => {});
    socket.on('timeout', () => this.emit('timeout'));
    socket.on('error', (error) => this.destroy(connectionError(error)));
    decoder.on('error', (error) => this.destroy(error));
    decoder.on('data', ({ type, payload }: HostdFrame) => {
      if (type === FRAME.STDOUT) { if (!this.push(payload)) decoder.pause(); return; }
      if (type === FRAME.STDERR) {
        this.#stderr = Buffer.concat([this.#stderr, payload]).subarray(-4096);
        this.emit('stderr', payload);
        return;
      }
      if (type !== FRAME.CONTROL) { this.destroy(new SpaceError('hostd_answer_unreadable', 'Unexpected hostd stream frame')); return; }
      try {
        const answer = parseControl(payload);
        if (hasProperties(answer) && answer.ok === false) throw remoteError(answer);
        const exit = hasProperties(answer) ? answer.exit : undefined;
        if (typeof exit !== 'number' || !Number.isInteger(exit) || exit < 0 || exit > 383) throw new SpaceError('hostd_answer_unreadable', 'Invalid hostd exit response');
        this.#finished = true;
        this.exitCode = exit;
        this.emit('exit', exit);
        if (exit !== 0 && this.bridge) this.destroy(new SpaceError('command_stream_failed', `Space bridge exited ${exit}: ${this.#stderr.toString('utf8')}`));
        else this.push(null);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        this.destroy(error);
      }
    });
    // Close can precede draining buffered stdout and the final exit frame.
    socket.on('close', () => { if (!decoder.writableEnded) decoder.end(); });
    decoder.once('end', () => { if (!this.#finished && !this.destroyed) this.destroy(new SpaceError('hostd_disconnected', 'hostd disconnected before the command ended')); });
  }

  override _read(): void { this.#decoder.resume(); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    const write = (offset: number): void => {
      if (offset >= chunk.length) { done(); return; }
      const end = Math.min(chunk.length, offset + MAX_FRAME_BYTES);
      this.#socket.write(frame(FRAME.STDIN, chunk.subarray(offset, end)), (error) => error ? done(error) : write(end));
    };
    write(0);
  }
  override _final(done: (error?: Error | null) => void): void { if (this.#finished) done(); else this.#socket.write(frame(FRAME.STDIN_END), done); }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void { this.#decoder.destroy(); this.#socket.destroy(); done(error); }
  setNoDelay(value?: boolean): this { this.#socket.setNoDelay(value); return this; }
  setKeepAlive(value?: boolean, delay?: number): this { this.#socket.setKeepAlive(value, delay); return this; }
  setTimeout(milliseconds: number, callback?: () => void): this {
    if (callback) { if (milliseconds > 0) this.once('timeout', callback); else this.removeListener('timeout', callback); }
    this.timeout = milliseconds;
    this.#socket.setTimeout(milliseconds);
    return this;
  }
  ref(): this { this.#socket.ref(); return this; }
  unref(): this { this.#socket.unref(); return this; }
}
