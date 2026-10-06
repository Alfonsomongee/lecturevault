import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioCaptureManager } from '../../src/capture/AudioCaptureManager.js';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

describe('AudioCaptureManager Unit Tests', () => {
  const silentLogger = pino({ level: 'silent' });
  const dummyPage = {} as any;
  const dummyContext = {} as any;

  let manager: AudioCaptureManager;

  beforeEach(() => {
    manager = new AudioCaptureManager(dummyPage, dummyContext, silentLogger, {
      outputDir: 'data/audio',
      allowedHosts: ['eu.bbcollab.com'],
    });
  });

  describe('sanitizeRecordingId', () => {
    it('cleans special characters and spaces', () => {
      const sanitized = manager.sanitizeRecordingId('Clase 1: Introducción a la ingeniería (2026)');
      expect(sanitized).toBe('Clase_1_Introducci_n_a_la_ingenier_a_2026_');
    });

    it('prevents path traversal attempts', () => {
      const sanitized = manager.sanitizeRecordingId('../../etc/passwd');
      expect(sanitized).not.toContain('..');
      expect(sanitized).not.toContain('/');
      expect(sanitized).not.toContain('\\');
    });

    it('falls back to timestamped default if empty', () => {
      const sanitized = manager.sanitizeRecordingId('');
      expect(sanitized).toMatch(/^recording-\d+$/);
    });

    it('truncates overly long filenames', () => {
      const longName = 'a'.repeat(200);
      const sanitized = manager.sanitizeRecordingId(longName);
      expect(sanitized.length).toBeLessThanOrEqual(80);
    });
  });

  describe('convertWebmTo16kHzMonoWav', () => {
    it('converts synthetic webm to 16kHz mono wav via ffmpeg', async () => {
      const testWebm = path.resolve('data/audio/scratch-test.webm');
      const testWav = path.resolve('data/audio/unit-test-converted.wav');

      if (fs.existsSync(testWebm)) {
        await manager.convertWebmTo16kHzMonoWav(testWebm, testWav);
        expect(fs.existsSync(testWav)).toBe(true);

        const stats = fs.statSync(testWav);
        expect(stats.size).toBeGreaterThan(1000);

        // Cleanup
        fs.unlinkSync(testWav);
      }
    });
  });
});
