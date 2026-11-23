import { z } from 'zod';

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const GEMINI_DEFAULT_VOICE = 'Kore';
const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
const PCM_SAMPLE_RATE = 24000;

type GeminiSpeechErrorCode = 'quota_exceeded' | 'no_credit' | 'key_rejected' | 'upstream_error';

export class GeminiSpeechError extends Error {
  readonly status: number;
  readonly code: GeminiSpeechErrorCode;

  constructor(message: string, { status, code }: { readonly status: number; readonly code: GeminiSpeechErrorCode }) {
    super(message);
    this.name = 'GeminiSpeechError';
    this.status = status;
    this.code = code;
  }
}

const wavFromPcm16 = (pcm: Buffer, sampleRate: number) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

const sampleRateOf = (mimeType: string | undefined) => {
  const match = /rate=(\d+)/.exec(mimeType ?? '');
  return match ? Number(match[1]) : PCM_SAMPLE_RATE;
};

const codeForStatus = (status: number): GeminiSpeechErrorCode => {
  if (status === 429) return 'quota_exceeded';
  if (status === 402) return 'no_credit';
  if (status === 400 || status === 401 || status === 403) return 'key_rejected';
  return 'upstream_error';
};

const speechErrorSchema = z.object({ error: z.object({ message: z.string() }) });
const inlineDataSchema = z.object({ inlineData: z.object({ data: z.string().min(1), mimeType: z.string().optional() }) });
const speechResponseSchema = z.object({ candidates: z.array(z.object({ content: z.object({ parts: z.array(z.unknown()) }) }).nullable().catch(null)) });
type SpeechConfig = { readonly voiceConfig: { readonly prebuiltVoiceConfig: { readonly voiceName: string } }; languageCode?: string };

export async function synthesizeGeminiSpeech({ text, apiKey, voice, languageCode, fetchImpl = fetch }: {
  readonly text: string;
  readonly apiKey: string;
  readonly voice?: string | undefined;
  readonly languageCode?: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): Promise<{ readonly buffer: Buffer; readonly contentType: 'audio/wav' }> {
  const speechConfig: SpeechConfig = {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: voice && GEMINI_VOICES.includes(voice) ? voice : GEMINI_DEFAULT_VOICE } },
  };
  if (languageCode) speechConfig.languageCode = languageCode;
  const response = await fetchImpl(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig },
    }),
  });

  if (!response.ok) {
    const payload = speechErrorSchema.safeParse(await response.json().catch(() => null));
    const message = payload.data?.error.message || `Gemini answered ${response.status}`;
    throw new GeminiSpeechError(message, { status: response.status, code: codeForStatus(response.status) });
  }

  const payload = speechResponseSchema.safeParse(await response.json());
  const inline = payload.data?.candidates[0]?.content.parts
    .map((part) => inlineDataSchema.safeParse(part)).find((part) => part.success)?.data?.inlineData;
  if (!inline) {
    throw new GeminiSpeechError('Gemini returned no audio', { status: 502, code: 'upstream_error' });
  }
  const audio = Buffer.from(inline.data, 'base64');
  const isWav = audio.subarray(0, 4).toString('latin1') === 'RIFF';
  return {
    buffer: isWav ? audio : wavFromPcm16(audio, sampleRateOf(inline.mimeType)),
    contentType: 'audio/wav',
  };
}
