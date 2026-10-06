import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateInputFilePath } from '../../src/transcriber/transcribe-cli.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('Transcription Security & Path Validation Unit Tests', () => {
  let tempBaseDir: string;
  let tempAudioFile: string;

  beforeAll(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-test-'));
    const dataDir = path.join(tempBaseDir, 'data', 'audio');
    fs.mkdirSync(dataDir, { recursive: true });
    tempAudioFile = path.join(dataDir, 'sample-audio.wav');
    fs.writeFileSync(tempAudioFile, 'RIFF mock wave audio data header');
  });

  afterAll(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  it('strictly rejects HTTP and HTTPS URLs', () => {
    expect(() => validateInputFilePath('https://example.com/audio.wav', tempBaseDir))
      .toThrow(/URLs are not allowed/);
    expect(() => validateInputFilePath('http://insecure.com/audio.mp3', tempBaseDir))
      .toThrow(/URLs are not allowed/);
  });

  it('strictly rejects network UNC paths', () => {
    expect(() => validateInputFilePath('\\\\server\\share\\audio.wav', tempBaseDir))
      .toThrow(/Network UNC paths are not allowed/);
  });

  it('strictly rejects files outside the project data directory', () => {
    const outsideFile = path.join(tempBaseDir, 'outside.wav');
    fs.writeFileSync(outsideFile, 'data');
    expect(() => validateInputFilePath(outsideFile, tempBaseDir))
      .toThrow(/must reside inside data/);
  });

  it('rejects unsupported media extensions', () => {
    const textFile = path.join(tempBaseDir, 'data', 'audio', 'notes.txt');
    fs.writeFileSync(textFile, 'hello');
    expect(() => validateInputFilePath(textFile, tempBaseDir))
      .toThrow(/Unsupported media format/);
  });

  it('rejects non-existent files', () => {
    const missing = path.join(tempBaseDir, 'data', 'audio', 'missing.wav');
    expect(() => validateInputFilePath(missing, tempBaseDir))
      .toThrow(/does not exist/);
  });

  it('accepts valid audio files located inside the data directory', () => {
    const validated = validateInputFilePath(tempAudioFile, tempBaseDir);
    expect(validated).toBe(path.resolve(tempAudioFile));
  });
});
