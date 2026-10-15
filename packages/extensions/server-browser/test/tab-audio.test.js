import { expect, test } from 'bun:test';
import { AUDIO_WORLD, createTabAudio } from '../src/tab-audio.js';

// A tab and a Chrome that records what it is sent and makes worlds at once.
const fixture = () => {
  const tab = { targetId: 't1', sessionId: 's1', mainFrameId: 'f1', dialog: null };
  const sent = [];
  const send = async (sessionId, method, params) => {
    sent.push(method === 'Page.createIsolatedWorld' ? [method, params.worldName] : [method]);
    return method === 'Page.createIsolatedWorld' ? { executionContextId: 42 } : {};
  };
  const audio = createTabAudio({ activeTab: () => tab, send });
  return { tab, sent, audio };
};

// What the capture script in the tab reports through the binding.
const packets = (epoch, count) => JSON.stringify({
  epoch,
  type: 'packets',
  sampleRate: 48_000,
  channels: 2,
  packets: Array.from({ length: count }, (_, index) => Buffer.from([1, 2, index]).toString('base64')),
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('hands a listener what came after it, and nothing captured before a stop', async () => {
  // Given a listener whose request starts the capture, and packets from it.
  const { tab, sent, audio } = fixture();
  expect(await audio.batch({ after: audio.head, wait: 0 })).toBeNull();
  await settle();
  expect(sent).toEqual([['Page.createIsolatedWorld', AUDIO_WORLD], ['Runtime.evaluate']]);
  audio.binding(tab, packets(1, 3));
  const first = await audio.batch({ after: 0, wait: 0 });
  expect(first).toMatchObject({ seq: 3, codec: 'opus', sampleRate: 48_000, channels: 2 });

  // When more is captured that nobody asks for before capture stops (the
  // viewer moved to another tab, or stopped listening).
  audio.binding(tab, packets(1, 2));
  audio.retarget();

  // Then a listener that comes back gets nothing old, only what is captured from then on.
  expect(await audio.batch({ after: first.seq, wait: 0 })).toBeNull();
  expect(audio.head).toBe(5);
  await settle();
  audio.binding(tab, packets(2, 1));
  expect(await audio.batch({ after: first.seq, wait: 0 })).toMatchObject({ seq: 6 });
  audio.close();
});

test('waits for a dialog to be answered before capturing a paused page', async () => {
  // Given the tab in front paused on a dialog.
  const { tab, sent, audio } = fixture();
  tab.dialog = { id: 1, type: 'alert', message: 'hi' };

  // When a listener asks for sound, then nothing is sent to the paused page.
  expect(await audio.batch({ after: audio.head, wait: 0 })).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sent).toEqual([]);

  // When the dialog is answered while the listener still waits, then capture starts.
  const waiting = audio.batch({ after: audio.head, wait: 2_000 });
  tab.dialog = null;
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(sent).toEqual([['Page.createIsolatedWorld', AUDIO_WORLD], ['Runtime.evaluate']]);
  audio.binding(tab, packets(1, 1));
  expect(await waiting).toMatchObject({ seq: 1 });
  audio.close();
});
