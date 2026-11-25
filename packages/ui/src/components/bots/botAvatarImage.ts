import { BOT_AVATAR_MAX_CHARS } from '@/lib/bots/config';

const SOURCE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const EDGE = 96;
const DECODE_WIDTH = EDGE * 2;
const QUALITIES = [0.86, 0.72, 0.58, 0.44] as const;

export type BotAvatarFailure = 'type' | 'size' | 'decode';
export class BotAvatarError extends Error {
  readonly name = 'BotAvatarError';
  constructor(readonly reason: BotAvatarFailure) { super(reason); }
}

export function botInitials(name: string, letters: 1 | 2 = 2): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  const initials = picked.map((word) => [...word][0] ?? '').join('');
  return ([...initials].slice(0, letters).join('') || '?').toLocaleUpperCase();
}

export async function readBotAvatar(file: File): Promise<string> {
  if (!SOURCE_TYPES.has(file.type)) throw new BotAvatarError('type');
  if (file.size > MAX_SOURCE_BYTES) throw new BotAvatarError('size');
  const bitmap = await createImageBitmap(file, { resizeWidth: DECODE_WIDTH, resizeQuality: 'medium' })
    .catch(() => { throw new BotAvatarError('decode'); });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = EDGE;
    canvas.height = EDGE;
    const context = canvas.getContext('2d');
    if (!context || bitmap.width === 0 || bitmap.height === 0) throw new BotAvatarError('decode');
    const side = Math.min(bitmap.width, bitmap.height);
    context.fillStyle = 'white';
    context.fillRect(0, 0, EDGE, EDGE);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, EDGE, EDGE);
    for (const quality of QUALITIES) {
      const encoded = canvas.toDataURL('image/jpeg', quality);
      if (encoded.startsWith('data:image/jpeg;base64,') && encoded.length <= BOT_AVATAR_MAX_CHARS) return encoded;
    }
    throw new BotAvatarError('size');
  } finally {
    bitmap.close();
  }
}
