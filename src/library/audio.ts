/**
 * Locating and optimising the local audio for a recording.
 *
 * The WAV (16 kHz mono PCM, ~115 MB/h) is what Whisper consumed and is expensive to recreate
 * (capture runs in real time), so it is never deleted. For playback we keep a small Opus copy
 * (~14 MB/h) next to it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isSafeTranscriptId } from '../utils/ids.js';

/** Preferred first: small formats before the raw WAV. */
export const PLAYBACK_EXTENSIONS = ['.opus', '.m4a', '.mp3', '.ogg', '.wav'];

export function audioDir(dataDir: string): string {
  return path.join(dataDir, 'audio');
}

export function findPlaybackAudio(dataDir: string, transcriptId: string | null): { dir: string; file: string } | null {
  if (!transcriptId || !isSafeTranscriptId(transcriptId)) return null;
  const dir = audioDir(dataDir);
  for (const ext of PLAYBACK_EXTENSIONS) {
    const file = `${transcriptId}${ext}`;
    if (fs.existsSync(path.join(dir, file))) return { dir, file };
  }
  return null;
}

/** Convert <id>.wav → <id>.opus (32 kbps, speech-tuned). Resolves with the output path. */
export function convertToOpus(dataDir: string, transcriptId: string): Promise<string> {
  if (!isSafeTranscriptId(transcriptId)) return Promise.reject(new Error('identificador no válido'));
  const input = path.join(audioDir(dataDir), `${transcriptId}.wav`);
  const output = path.join(audioDir(dataDir), `${transcriptId}.opus`);
  if (!fs.existsSync(input)) return Promise.reject(new Error(`No existe ${input}`));

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', input, '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', output],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`)));
    proc.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`ffmpeg terminó con código ${code}: ${stderr.slice(0, 300)}`))
    );
  });
}
