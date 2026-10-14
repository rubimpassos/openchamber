/**
 * Read-aloud through Google's Gemini speech models.
 *
 * Gemini has no OpenAI-style `/audio/speech` endpoint, not even in its
 * OpenAI compatibility layer: speech comes from `generateContent` with an
 * audio response. One request per reading on purpose — the free tier allows
 * about ten requests a day, so splitting a reply into sentences would spend
 * the day's quota on two or three replies.
 */

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const GEMINI_DEFAULT_VOICE = 'Kore';
const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`;
const PCM_SAMPLE_RATE = 24000;

/** A failure the route can answer with Gemini's own status and a stable code. */
export class GeminiSpeechError extends Error {
  constructor(message, { status, code }) {
    super(message);
    this.name = 'GeminiSpeechError';
    this.status = status;
    this.code = code;
  }
}

/** Mono 16-bit PCM wrapped in a WAV header, so browsers can decode it. */
const wavFromPcm16 = (pcm, sampleRate) => {
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

const sampleRateOf = (mimeType) => {
  const match = /rate=(\d+)/.exec(mimeType ?? '');
  return match ? Number(match[1]) : PCM_SAMPLE_RATE;
};

const codeForStatus = (status) => {
  if (status === 429) return 'quota_exceeded';
  if (status === 402) return 'no_credit';
  if (status === 400 || status === 401 || status === 403) return 'key_rejected';
  return 'upstream_error';
};

/**
 * @param {{ text: string, apiKey: string, voice?: string, languageCode?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ buffer: Buffer, contentType: 'audio/wav' }>}
 */
export async function synthesizeGeminiSpeech({ text, apiKey, voice, languageCode, fetchImpl = fetch }) {
  const speechConfig = {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICES.includes(voice) ? voice : GEMINI_DEFAULT_VOICE } },
  };
  if (languageCode) speechConfig.languageCode = languageCode;
  // Only the text: an instruction placed before it gets read aloud too.
  const response = await fetchImpl(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig },
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message = payload?.error?.message || `Gemini answered ${response.status}`;
    throw new GeminiSpeechError(message, { status: response.status, code: codeForStatus(response.status) });
  }

  const payload = await response.json();
  const inline = payload?.candidates?.[0]?.content?.parts?.find((part) => part?.inlineData?.data)?.inlineData;
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
