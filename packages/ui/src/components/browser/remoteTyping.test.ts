import { describe, expect, test } from 'bun:test';
import type { SurfaceInputEvent } from '@openchamber/sdk';

import { routeTypingKey, typingStep } from './remoteTyping';

const SAME_FIELD = { composing: false, changed: false };

const summarize = (events: readonly SurfaceInputEvent[]): string[] => events.flatMap((event) => {
  if (event.type === 'text') return [`text:${event.text}`];
  if (event.type !== 'key' || event.action !== 'down') return [];
  return [`${event.modifiers.shift ? 'shift+' : ''}${event.key}`];
});

describe('typing into a remote page', () => {
  test('typed characters reach the page as text, in order', () => {
    const first = typingStep('', 'h', SAME_FIELD);
    const second = typingStep(first.mirror, 'he', SAME_FIELD);
    expect(summarize([...first.events, ...second.events])).toEqual(['text:h', 'text:e']);
    expect(second.mirror).toBe('he');
  });

  test('every key press releases its key', () => {
    const { events } = typingStep('ab', 'a', SAME_FIELD);
    expect(events.map((event) => (event.type === 'key' ? `${event.action}:${event.key}:${event.keyCode}` : event.type)))
      .toEqual(['down:Backspace:8', 'up:Backspace:8']);
  });

  test('autocorrect takes back the word it replaces, then types the correction', () => {
    expect(summarize(typingStep('teh', 'the ', SAME_FIELD).events)).toEqual(['Backspace', 'Backspace', 'text:he ']);
  });

  test('an emoji sequence is one Backspace, however many code units it holds', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const flag = '\u{1F1E7}\u{1F1F7}';
    expect(summarize(typingStep(`a${family}${flag}`, 'a', SAME_FIELD).events)).toEqual(['Backspace', 'Backspace']);
  });

  test('a letter with a combining mark is selected, since one Backspace would leave the letter', () => {
    const accented = 'e\u0301';
    expect(summarize(typingStep(`x${accented}`, 'x', SAME_FIELD).events)).toEqual(['shift+ArrowLeft', 'Backspace']);
    expect(summarize(typingStep(`x${accented}`, 'xo', SAME_FIELD).events)).toEqual(['shift+ArrowLeft', 'text:o']);
  });

  test('removing only the combining mark retypes the bare letter', () => {
    expect(summarize(typingStep('e\u0301', 'e', SAME_FIELD).events)).toEqual(['shift+ArrowLeft', 'text:e']);
  });

  test('an IME replaces its composing letters with the chosen characters', () => {
    const composing = typingStep('', 'ni', { composing: true, changed: false });
    const chosen = typingStep(composing.mirror, '\u4F60', SAME_FIELD);
    expect(summarize(chosen.events)).toEqual(['Backspace', 'Backspace', 'text:\u4F60']);
    expect(chosen.mirror).toBe('\u4F60');
  });

  test('a line break presses Enter and starts the mirror over', () => {
    const step = typingStep('hi', 'hi\nyo', SAME_FIELD);
    expect(summarize(step.events)).toEqual(['Enter', 'text:yo']);
    expect(step.mirror).toBe('');
  });

  test('a selection replaced by a line break is deleted before Enter', () => {
    expect(summarize(typingStep('e\u0301', '\n', SAME_FIELD).events)).toEqual(['shift+ArrowLeft', 'Backspace', 'Enter']);
  });

  test('after the page changed, a correction cannot delete in the new field', () => {
    const step = typingStep('old word', 'old work', { composing: false, changed: true });
    expect(summarize(step.events)).toEqual(['text:k']);
    expect(step.mirror).toBe('k');
  });

  test('a long mirror starts over between words, never while composing', () => {
    const long = 'a'.repeat(2000);
    expect(typingStep(long, `${long}b`, SAME_FIELD).mirror).toBe('');
    expect(typingStep(long, `${long}b`, { composing: true, changed: false }).mirror).toBe(`${long}b`);
  });
});

describe('keys pressed in the typing field', () => {
  const pressed = { key: 'a', keyCode: 65, composing: false, chord: false, fieldEmpty: false };

  test('text keys stay in the field, whose change is what the page receives', () => {
    expect(routeTypingKey(pressed)).toBe('field');
    expect(routeTypingKey({ ...pressed, key: 'Unidentified', keyCode: 229 })).toBe('field');
    expect(routeTypingKey({ ...pressed, key: 'Enter', keyCode: 13, composing: true })).toBe('field');
  });

  test('Backspace edits the field while it holds text and goes to the page once it is empty', () => {
    expect(routeTypingKey({ ...pressed, key: 'Backspace', keyCode: 8 })).toBe('field');
    expect(routeTypingKey({ ...pressed, key: 'Backspace', keyCode: 8, fieldEmpty: true })).toBe('page');
  });

  test('editing keys and shortcuts go to the page', () => {
    expect(routeTypingKey({ ...pressed, key: 'Enter', keyCode: 13 })).toBe('page');
    expect(routeTypingKey({ ...pressed, key: 'ArrowLeft', keyCode: 37 })).toBe('page');
    expect(routeTypingKey({ ...pressed, chord: true })).toBe('page');
  });

  test('a modifier on its own leaves the typed text correctable', () => {
    expect(routeTypingKey({ ...pressed, key: 'Shift', keyCode: 16 })).toBe('page-keeping-mirror');
  });
});
