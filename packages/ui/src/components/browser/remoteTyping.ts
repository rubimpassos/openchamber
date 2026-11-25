import type { SurfaceInputEvent, SurfaceModifiers } from '@openchamber/sdk';

const NO_MODIFIERS: SurfaceModifiers = { alt: false, ctrl: false, meta: false, shift: false };
const SHIFT_ONLY: SurfaceModifiers = { alt: false, ctrl: false, meta: false, shift: true };

const MIRROR_MAX_LENGTH = 2000;

const KEY_CODES = { Backspace: 8, Enter: 13, ArrowLeft: 37 } as const;
type RemoteEditingKey = keyof typeof KEY_CODES;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const graphemesOf = (text: string): string[] => Array.from(graphemeSegmenter.segment(text), (part) => part.segment);

const EMOJI_UNIT = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

const removedByOneBackspace = (grapheme: string): boolean => Array.from(grapheme).length === 1 || EMOJI_UNIT.test(grapheme);

const keyPress = (key: RemoteEditingKey, modifiers: SurfaceModifiers = NO_MODIFIERS): SurfaceInputEvent[] => [
  { type: 'key', action: 'down', key, code: key, keyCode: KEY_CODES[key], modifiers },
  { type: 'key', action: 'up', key, code: key, keyCode: KEY_CODES[key], modifiers },
];

const removalEvents = (removed: readonly string[], replacedByText: boolean): SurfaceInputEvent[] => {
  if (removed.length === 0) return [];
  if (removed.every(removedByOneBackspace)) return removed.flatMap(() => keyPress('Backspace'));
  const selection = removed.flatMap(() => keyPress('ArrowLeft', SHIFT_ONLY));
  return replacedByText ? selection : [...selection, ...keyPress('Backspace')];
};

const insertionEvents = (inserted: string): SurfaceInputEvent[] => inserted.split('\n').flatMap((line, index) => [
  ...(index > 0 ? keyPress('Enter') : []),
  ...(line ? [{ type: 'text' as const, text: line }] : []),
]);

type TypingStep = {
  readonly events: SurfaceInputEvent[];
  readonly mirror: string;
};

type TypingTarget = {
  readonly composing: boolean;
  readonly changed: boolean;
};

export const typingStep = (previous: string, next: string, target: TypingTarget): TypingStep => {
  const before = graphemesOf(previous);
  const after = graphemesOf(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common += 1;
  const inserted = after.slice(common).join('');
  const firstLine = inserted.split('\n')[0];
  const events = [
    ...(target.changed ? [] : removalEvents(before.slice(common), firstLine.length > 0)),
    ...insertionEvents(inserted),
  ];
  if (inserted.includes('\n')) return { events, mirror: '' };
  if (target.changed) return { events, mirror: inserted };
  if (!target.composing && next.length > MIRROR_MAX_LENGTH) return { events, mirror: '' };
  return { events, mirror: next };
};

const UNMIRRORED_KEYS = new Set(['Unidentified', 'Process', 'Dead']);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

type TypingKey = {
  readonly key: string;
  readonly keyCode: number;
  readonly composing: boolean;
  readonly chord: boolean;
  readonly fieldEmpty: boolean;
};

type TypingKeyRoute = 'field' | 'page' | 'page-keeping-mirror';

export const routeTypingKey = (pressed: TypingKey): TypingKeyRoute => {
  if (pressed.composing || pressed.keyCode === 229 || UNMIRRORED_KEYS.has(pressed.key)) return 'field';
  if (MODIFIER_KEYS.has(pressed.key)) return 'page-keeping-mirror';
  if (Array.from(pressed.key).length === 1 && !pressed.chord) return 'field';
  if (pressed.key === 'Backspace' && !pressed.fieldEmpty) return 'field';
  return 'page';
};
