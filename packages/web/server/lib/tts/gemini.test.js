import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import { GEMINI_TTS_MODEL, GeminiSpeechError, synthesizeGeminiSpeech } from './gemini.js';
import { speechLanguageCode } from './language-detect.js';
import { registerTtsRoutes } from './routes.js';
import { updateVoiceKeys } from './voice-keys.js';

const audioResponse = (data, mimeType) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType, data: data.toString('base64') } }] } }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

const recordingFetch = (response) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return { calls, fetchImpl };
};

describe('synthesizeGeminiSpeech', () => {
  it('sends only the text, with the voice and language code, to the Flash-Lite speech model', async () => {
    const { calls, fetchImpl } = recordingFetch(audioResponse(Buffer.from('RIFF....WAVE'), 'audio/wav'));
    await synthesizeGeminiSpeech({ text: 'Fiz o deploy da branch', apiKey: 'AIza-test', voice: 'Puck', languageCode: 'pt-BR', fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/models/${GEMINI_TTS_MODEL}:generateContent`);
    expect(calls[0].init.headers['x-goog-api-key']).toBe('AIza-test');
    expect(calls[0].body.contents).toEqual([{ parts: [{ text: 'Fiz o deploy da branch' }] }]);
    expect(calls[0].body.generationConfig).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }, languageCode: 'pt-BR' },
    });
  });

  it('falls back to Kore for an unknown voice', async () => {
    const { calls, fetchImpl } = recordingFetch(audioResponse(Buffer.from('RIFF....WAVE'), 'audio/wav'));
    await synthesizeGeminiSpeech({ text: 'oi', apiKey: 'k', voice: 'coral', fetchImpl });
    expect(calls[0].body.generationConfig.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } });
  });

  it('wraps raw PCM in a WAV header at the rate Gemini reports', async () => {
    const pcm = Buffer.alloc(480);
    const { fetchImpl } = recordingFetch(audioResponse(pcm, 'audio/L16;codec=pcm;rate=24000'));
    const result = await synthesizeGeminiSpeech({ text: 'oi', apiKey: 'k', fetchImpl });

    expect(result.contentType).toBe('audio/wav');
    expect(result.buffer.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(result.buffer.readUInt32LE(24)).toBe(24000);
    expect(result.buffer.length).toBe(44 + pcm.length);
  });

  it('reports a spent daily quota as quota_exceeded', async () => {
    const { fetchImpl } = recordingFetch(new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 }));
    const failure = synthesizeGeminiSpeech({ text: 'oi', apiKey: 'k', fetchImpl });
    await expect(failure).rejects.toBeInstanceOf(GeminiSpeechError);
    await expect(failure).rejects.toMatchObject({ status: 429, code: 'quota_exceeded', message: 'Quota exceeded' });
  });
});

describe('speechLanguageCode', () => {
  it('names the regional locale speech APIs expect', () => {
    expect(speechLanguageCode('pt')).toBe('pt-BR');
    expect(speechLanguageCode('en')).toBe('en-US');
    expect(speechLanguageCode('xx')).toBeNull();
  });
});

describe('POST /api/tts/gemini/speak', () => {
  const createApp = () => {
    const app = express();
    app.use(express.json());
    registerTtsRoutes(app, { sayTTSCapability: null });
    return app;
  };

  const withDataDir = async (run) => {
    const previous = process.env.OPENCHAMBER_DATA_DIR;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gemini-tts-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previous;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };

  it('asks for a key when none is stored', () => withDataDir(async () => {
    const response = await request(createApp()).post('/api/tts/gemini/speak').send({ text: 'Fiz o deploy' });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('key_missing');
  }));

  it('refuses in enterprise mode even with a key stored', () => withDataDir(async () => {
    updateVoiceKeys({ gemini: 'AIza-test' });
    process.env.OPENCHAMBER_ENTERPRISE_MODE = 'true';
    try {
      const response = await request(createApp()).post('/api/tts/gemini/speak').send({ text: 'Fiz o deploy' });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('enterprise_mode');
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  }));
});
