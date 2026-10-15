/**
 * Plays the sound a shared surface sends: batches of Opus packets, each a
 * 2-byte big-endian length followed by the packet. WebCodecs decodes them and
 * Web Audio schedules each one right after the previous, a little ahead of
 * now, so the stream plays without gaps while it keeps arriving.
 */

export type SurfaceAudioBatch = {
  codec: 'opus';
  sampleRate: number;
  channels: number;
  bytes: ArrayBuffer;
};

/**
 * Opus decodes at 48 kHz whatever rate it was captured at (RFC 7845), and
 * Chrome's decoder refuses any other rate in `configure`, even one
 * `isConfigSupported` accepts.
 */
const OPUS_DECODE_RATE = 48_000;
/** Sound scheduled this far ahead absorbs the jitter of the socket. */
const LEAD_SECONDS = 0.12;
/**
 * Sound queued further ahead than this came in a burst (the connection
 * stalled, then caught up): what is queued is dropped and playback starts
 * again from the newest, so a burst never plays late, or over itself.
 */
const MAX_QUEUED_SECONDS = 0.5;

/**
 * When the next buffer plays: right after the previous one, or a little
 * ahead of `now` when that time has passed. `restart` means too much is
 * queued and what is queued should stop first.
 */
export const nextAudioSlot = (now: number, nextStart: number) => {
  if (nextStart > now + MAX_QUEUED_SECONDS) return { start: now + LEAD_SECONDS, restart: true };
  if (nextStart < now) return { start: now + LEAD_SECONDS, restart: false };
  return { start: nextStart, restart: false };
};

/** Splits a batch into packets; null when the lengths do not add up. */
export const splitAudioPackets = (bytes: ArrayBuffer): Uint8Array[] | null => {
  const view = new DataView(bytes);
  const packets: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 2 > bytes.byteLength) return null;
    const length = view.getUint16(offset);
    if (length === 0 || offset + 2 + length > bytes.byteLength) return null;
    packets.push(new Uint8Array(bytes, offset + 2, length));
    offset += 2 + length;
  }
  return packets;
};

/** Whether this runtime can play surface sound: Web Audio and a WebCodecs Opus decoder. */
export const supportsSurfaceAudio = async (): Promise<boolean> => {
  if (typeof AudioDecoder !== 'function' || typeof AudioContext !== 'function' || typeof EncodedAudioChunk !== 'function') return false;
  try {
    const { supported } = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: OPUS_DECODE_RATE, numberOfChannels: 2 });
    return supported === true;
  } catch {
    return false;
  }
};

export class SurfaceAudioPlayer {
  private context: AudioContext | null = null;
  private decoder: AudioDecoder | null = null;
  private format: string | null = null;
  private nextStart = 0;
  private timestamp = 0;
  private disposed = false;
  private readonly queued = new Set<AudioBufferSourceNode>();

  /**
   * Starts the output. Call it from the click that turns sound on: browsers
   * only let a page start audio in answer to the person.
   */
  resume(): void {
    if (this.disposed) return;
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    void this.context.resume().catch(() => undefined);
  }

  play(batch: SurfaceAudioBatch): void {
    if (this.disposed || !this.context) return;
    const packets = splitAudioPackets(batch.bytes);
    if (!packets) return;
    const decoder = this.decoderFor(batch);
    if (!decoder) return;
    for (const packet of packets) {
      // Timestamps only order the packets for the decoder; playback time is
      // kept by `nextStart`.
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: this.timestamp, data: packet }));
      this.timestamp += 20_000;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeDecoder();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private decoderFor(batch: SurfaceAudioBatch): AudioDecoder | null {
    const format = `${batch.codec}/${batch.channels}`;
    if (this.decoder && this.format === format && this.decoder.state === 'configured') return this.decoder;
    this.closeDecoder();
    try {
      const decoder = new AudioDecoder({
        output: (data) => this.schedule(data),
        // A packet the decoder refuses is dropped; the next batch starts over.
        error: () => {
          if (this.decoder === decoder) this.closeDecoder();
        },
      });
      decoder.configure({ codec: batch.codec, sampleRate: OPUS_DECODE_RATE, numberOfChannels: batch.channels });
      this.decoder = decoder;
      this.format = format;
      return decoder;
    } catch {
      return null;
    }
  }

  private closeDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    this.format = null;
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close();
      } catch {
        // already closed
      }
    }
  }

  private schedule(data: AudioData): void {
    const context = this.context;
    if (!context || this.disposed) {
      data.close();
      return;
    }
    try {
      const buffer = context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
      for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
        buffer.copyToChannel(samples, channel);
      }
      const slot = nextAudioSlot(context.currentTime, this.nextStart);
      if (slot.restart) {
        for (const queued of this.queued) queued.stop();
        this.queued.clear();
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => this.queued.delete(source);
      source.start(slot.start);
      this.queued.add(source);
      this.nextStart = slot.start + buffer.duration;
    } catch {
      // A buffer the context cannot take is skipped.
    } finally {
      data.close();
    }
  }
}
