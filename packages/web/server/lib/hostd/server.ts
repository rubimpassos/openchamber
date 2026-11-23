import net from 'node:net';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { SpaceError } from '../spaces/errors.js';
import { FRAME, FrameDecoder, controlFrame, parseControl, writeFrame } from './protocol.js';
import type { HostdFrame } from './protocol.js';
import type { ParsedHostdRequest } from './contracts.js';
import { MAX_FILL_BYTES, parseRequest } from './validation.js';

type FrameIterator = AsyncIterator<HostdFrame, void>;
type HostdReplyValue = null | boolean | number | string | readonly HostdReplyValue[]
  | { readonly [key: string]: HostdReplyValue | undefined };
export type HostdServerIO = {
  readonly signal: AbortSignal;
  readonly stdin: Readable;
  readonly input: Buffer | undefined;
  readonly stdout: (bytes: Uint8Array) => Promise<void>;
  readonly stderr: (bytes: Uint8Array) => Promise<void>;
};

async function* inputFrames(iterator: FrameIterator) {
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new SpaceError('stdin_incomplete', 'hostd stdin ended without an end frame');
    if (next.value.type === FRAME.STDIN_END) return;
    if (next.value.type !== FRAME.STDIN) throw new SpaceError('invalid_frame_order', 'Only stdin frames may follow a request');
    yield next.value.payload;
  }
}

async function readFill(request: Extract<ParsedHostdRequest, { op: 'tools-ensure' }>, iterator: FrameIterator, socket: net.Socket) {
  if (request.input !== null) return Buffer.from(request.input, 'base64');
  const chunks: Buffer[] = [];
  let length = 0;
  const deadline = setTimeout(() => socket.destroy(new SpaceError('input_timeout', 'Tools input upload timed out')), 60_000);
  try {
    for await (const chunk of inputFrames(iterator)) {
      length += chunk.length;
      if (length > MAX_FILL_BYTES) throw new SpaceError('input_too_large', 'Tools input exceeds 64 MiB');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally { clearTimeout(deadline); }
}

const failureSchema = z.object({ code: z.string().catch('hostd_failed'), message: z.unknown(), details: z.unknown() })
  .catch({ code: 'hostd_failed', message: undefined, details: undefined });

export function createHostdServer(daemon: { readonly request: (request: ParsedHostdRequest, io: HostdServerIO) => Promise<HostdReplyValue | undefined> }) {
  const connections = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (connections.size >= 64) { socket.end(controlFrame({ ok: false, code: 'hostd_busy', message: 'Too many hostd connections' })); return; }
    connections.add(socket);
    socket.on('error', () => {});
    const abort = new AbortController();
    socket.once('end', () => { abort.abort(); socket.destroy(); });
    socket.once('close', () => { connections.delete(socket); abort.abort(); });
    const decoder = new FrameDecoder();
    const handshake = setTimeout(() => socket.destroy(), 10_000);
    socket.once('close', () => clearTimeout(handshake));
    socket.on('error', (error) => decoder.destroy(error));
    socket.on('close', () => decoder.destroy());
    socket.pipe(decoder);
    void (async () => {
      const iterator: FrameIterator = decoder[Symbol.asyncIterator]();
      const first = await iterator.next();
      clearTimeout(handshake);
      if (first.done || first.value.type !== FRAME.CONTROL) throw new SpaceError('invalid_frame_order', 'The first hostd frame must be a control request');
      const request = parseRequest(parseControl(first.value.payload));
      const streamed = request.op === 'exec' || request.op === 'attach';
      const input = request.op === 'tools-ensure' ? await readFill(request, iterator, socket) : undefined;
      const io: HostdServerIO = { signal: abort.signal, stdin: Readable.from(inputFrames(iterator)), input,
        stdout: (bytes) => writeFrame(socket, FRAME.STDOUT, bytes), stderr: (bytes) => writeFrame(socket, FRAME.STDERR, bytes) };
      if (streamed) socket.write(controlFrame({ ok: true }));
      const result = await daemon.request(request, io);
      socket.end(controlFrame(streamed ? { exit: result } : { ok: true, result: result ?? null }));
    })().catch((error) => {
      const { code, message, details } = failureSchema.parse(error);
      if (!socket.destroyed) socket.end(controlFrame({ ok: false, code, message: String(message ?? 'hostd failed').slice(0, 2000), details }));
    });
  });
  return { server, close: async () => { for (const socket of connections) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
