import {
  SURFACE_AUDIO_CHANNELS_MAX,
  SURFACE_AUDIO_MAX_BYTES,
  SURFACE_AUDIO_SAMPLE_RATE_MAX,
  SURFACE_AUDIO_SAMPLE_RATE_MIN,
} from '@openchamber/sdk';

// The sound of the tab a viewer sees, for `GET /surface/audio`. The service
// captures the tab from an isolated world of its own (pages cannot reach it,
// and capture-guard.js keeps pages from capturing themselves), encodes Opus
// there with WebCodecs, and hands packets over through a binding only that
// world has. Nothing is captured until a viewer asks for sound, and capture
// stops a few seconds after the last request.

export const AUDIO_WORLD = 'openchamber-tab-audio';
export const AUDIO_BINDING = 'openchamberTabAudio';

// About five seconds of 20 ms packets: a viewer behind by more skips ahead.
const RING_MAX = 250;
const IDLE_STOP_MS = 5_000;
// A new document needs a moment before a world can be made in it.
const RESTART_DELAY_MS = 300;
const PACKET_MAX_BYTES = 65_535;

// Silent stretches are not encoded, so nothing is sent while a page is quiet.
const captureScript = (epoch) => `void (async () => {
  const report = (message) => {
    try { ${AUDIO_BINDING}(JSON.stringify({ epoch: ${epoch}, ...message })); } catch {}
  };
  globalThis.__openchamberTabAudio?.stop();
  const state = { stopped: false, stop() { this.stopped = true; } };
  globalThis.__openchamberTabAudio = state;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
      preferCurrentTab: true,
    });
  } catch (error) {
    report({ type: 'error', message: String(error && error.name || error) });
    return;
  }
  for (const track of stream.getVideoTracks()) track.stop();
  const [track] = stream.getAudioTracks();
  if (!track) {
    report({ type: 'error', message: 'no-audio-track' });
    return;
  }
  state.stop = () => { state.stopped = true; track.stop(); };
  if (state.stopped) {
    track.stop();
    return;
  }
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let encoder = null;
  let config = null;
  let batch = [];
  const flush = () => {
    if (batch.length === 0 || !config) return;
    report({ type: 'packets', sampleRate: config.sampleRate, channels: config.channels, packets: batch });
    batch = [];
  };
  const timer = setInterval(flush, 100);
  const toBase64 = (bytes) => {
    let text = '';
    for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
    return btoa(text);
  };
  const silent = (data) => {
    const samples = new Float32Array(data.numberOfFrames);
    for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
      data.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
      for (let index = 0; index < samples.length; index += 1) {
        if (Math.abs(samples[index]) > 0.0001) return false;
      }
    }
    return true;
  };
  try {
    while (!state.stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!encoder) {
        config = { sampleRate: value.sampleRate, channels: Math.min(${SURFACE_AUDIO_CHANNELS_MAX}, value.numberOfChannels) };
        encoder = new AudioEncoder({
          output: (chunk) => {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            batch.push(toBase64(bytes));
          },
          error: (error) => {
            report({ type: 'error', message: String(error) });
            state.stop();
          },
        });
        encoder.configure({ codec: 'opus', sampleRate: config.sampleRate, numberOfChannels: config.channels, bitrate: 96000 });
      }
      if (!state.stopped && encoder.state === 'configured' && !silent(value)) encoder.encode(value);
      value.close();
    }
  } finally {
    clearInterval(timer);
    try { await encoder?.flush(); } catch {}
    flush();
    track.stop();
  }
})()`;

const validConfig = (sampleRate, channels) => (
  Number.isInteger(sampleRate)
  && sampleRate >= SURFACE_AUDIO_SAMPLE_RATE_MIN
  && sampleRate <= SURFACE_AUDIO_SAMPLE_RATE_MAX
  && Number.isInteger(channels)
  && channels >= 1
  && channels <= SURFACE_AUDIO_CHANNELS_MAX
);

/**
 * `activeTab()` is the tab the viewer sees (with `sessionId` and
 * `mainFrameId`); `send(sessionId, method, params)` talks to Chrome.
 */
export const createTabAudio = ({ activeTab, send }) => {
  let capture = null;
  let epoch = 0;
  let sequence = 0;
  const packets = [];
  const waiters = new Set();
  let inflight = 0;
  let idleTimer = null;
  let restartTimer = null;
  // Why the page in front gives no sound (an insecure page has no capture); cleared when it changes.
  let unavailable = false;
  let closed = false;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const stop = () => {
    const current = capture;
    capture = null;
    // What was captured and not asked for is no longer live: a listener that
    // comes back later must not get it as a burst of old sound.
    packets.length = 0;
    clearTimeout(restartTimer);
    restartTimer = null;
    if (current?.contextId) {
      void send(current.tab.sessionId, 'Runtime.evaluate', {
        contextId: current.contextId,
        expression: 'globalThis.__openchamberTabAudio?.stop()',
      }).catch(() => {});
    }
  };

  const start = async () => {
    const tab = activeTab();
    if (closed || !tab || unavailable || capture?.tab === tab) return;
    // A page paused on a dialog makes no world and runs no script until it
    // is answered; waiting on it would end in a timeout taken for no sound.
    if (tab.dialog) {
      restartSoon();
      return;
    }
    stop();
    epoch += 1;
    const mine = { tab, epoch, contextId: null };
    capture = mine;
    try {
      const world = await send(tab.sessionId, 'Page.createIsolatedWorld', { frameId: tab.mainFrameId, worldName: AUDIO_WORLD });
      if (capture !== mine) return;
      mine.contextId = world.executionContextId;
      await send(tab.sessionId, 'Runtime.evaluate', {
        contextId: world.executionContextId,
        expression: captureScript(mine.epoch),
        userGesture: true,
      });
    } catch {
      if (capture === mine) {
        capture = null;
        unavailable = true;
      }
    }
  };

  const wanted = () => inflight > 0 && !closed;

  const restartSoon = () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (wanted()) void start();
    }, RESTART_DELAY_MS);
    restartTimer.unref?.();
  };

  const armIdleStop = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inflight === 0) stop();
    }, IDLE_STOP_MS);
    idleTimer.unref?.();
  };

  // Packets after `after`, as many as one answer holds, all of one format.
  const batchAfter = (after) => {
    const pending = packets.filter((packet) => packet.seq > after);
    if (pending.length === 0) return null;
    const { sampleRate, channels } = pending[0];
    const chosen = [];
    let size = 0;
    for (const packet of pending) {
      if (packet.sampleRate !== sampleRate || packet.channels !== channels) break;
      if (size + 2 + packet.bytes.length > SURFACE_AUDIO_MAX_BYTES) break;
      chosen.push(packet);
      size += 2 + packet.bytes.length;
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    for (const packet of chosen) {
      bytes.writeUInt16BE(packet.bytes.length, offset);
      packet.bytes.copy(bytes, offset + 2);
      offset += 2 + packet.bytes.length;
    }
    return { seq: chosen.at(-1).seq, codec: 'opus', sampleRate, channels, bytes };
  };

  return {
    get unavailable() {
      return unavailable;
    },

    /** The newest packet's number: a new listener starts there instead of replaying. */
    get head() {
      return sequence;
    },

    /** Packets newer than `after`, held up to `wait` ms; null when none came. */
    async batch({ after, wait, signal }) {
      if (closed) return null;
      inflight += 1;
      clearTimeout(idleTimer);
      try {
        void start();
        const ready = batchAfter(after);
        if (ready || wait === 0) return ready;
        await new Promise((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            waiters.delete(finish);
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = () => {
            finish();
            reject(signal.reason ?? new DOMException('Audio request cancelled', 'AbortError'));
          };
          const timer = setTimeout(finish, wait);
          timer.unref?.();
          waiters.add(finish);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
        return batchAfter(after);
      } finally {
        inflight -= 1;
        if (inflight === 0) armIdleStop();
      }
    },

    /** A call of the audio binding from `tab`. */
    binding(tab, payload) {
      if (!capture || capture.tab !== tab) return;
      let message;
      try {
        message = JSON.parse(payload);
      } catch {
        return;
      }
      if (message?.epoch !== capture.epoch) return;
      if (message.type === 'error') {
        capture = null;
        unavailable = true;
        wake();
        return;
      }
      if (message.type !== 'packets' || !Array.isArray(message.packets) || !validConfig(message.sampleRate, message.channels)) return;
      for (const encoded of message.packets) {
        if (typeof encoded !== 'string') continue;
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length === 0 || bytes.length > PACKET_MAX_BYTES) continue;
        sequence += 1;
        packets.push({ seq: sequence, sampleRate: message.sampleRate, channels: message.channels, bytes });
      }
      if (packets.length > RING_MAX) packets.splice(0, packets.length - RING_MAX);
      wake();
    },

    /** The viewer now sees another tab: its sound replaces this one's. */
    retarget() {
      stop();
      unavailable = false;
      if (wanted()) void start();
    },

    /** `tab` loaded a new document, which took the capture's world with it. */
    navigated(tab) {
      if (activeTab() !== tab) return;
      unavailable = false;
      if (capture?.tab === tab) capture = null;
      if (wanted()) restartSoon();
    },

    forget(tab) {
      if (capture?.tab === tab) capture = null;
    },

    close() {
      closed = true;
      clearTimeout(idleTimer);
      stop();
      wake();
    },
  };
};
