import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptRefiner } from '../../src/ai/TranscriptRefiner.js';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

describe('TranscriptRefiner Unit Tests', () => {
  const silentLogger = pino({ level: 'silent' });

  it('throws error if API key is missing', async () => {
    const refiner = new TranscriptRefiner({ apiKey: '', logger: silentLogger });
    await expect(refiner.refineTranscript('texto de prueba')).rejects.toThrow('GEMINI_API_KEY no está configurada');
  });

  it('throws error if input text is empty', async () => {
    const refiner = new TranscriptRefiner({ apiKey: 'dummy-key', logger: silentLogger });
    await expect(refiner.refineTranscript('   ')).rejects.toThrow('La transcripción de entrada está vacía');
  });

  it('sends prompt to Gemini API and receives structured response', async () => {
    const fakeResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: '# Apuntes Limpios\n\n## 1. Resumen\nContenido filtrado.' }
            ]
          }
        }
      ]
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    });

    vi.stubGlobal('fetch', mockFetch);

    const refiner = new TranscriptRefiner({ apiKey: 'valid-test-key', logger: silentLogger });
    const result = await refiner.refineTranscript('bueno este básicamente vamos a hablar de ansys');

    expect(result).toContain('# Apuntes Limpios');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
