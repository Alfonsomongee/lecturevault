/**
 * Transcribe CLI Wrapper — Milestone 4
 *
 * Validates input audio path security:
 * - Rejects URLs and network shares
 * - Strictly ensures the file is within the project's data directory
 * - Validates supported extensions (.wav, .mp3, .m4a, etc.)
 * Invokes the project-local Python virtual environment (.venv).
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export interface TranscribeOptions {
  inputFile: string;
  model?: string;
  device?: string;
  computeType?: string;
  language?: string;
}

export function validateInputFilePath(inputRaw: string, baseDir: string = process.cwd()): string {
  if (!inputRaw || typeof inputRaw !== 'string') {
    throw new Error('Input audio file path is required.');
  }

  const trimmed = inputRaw.trim();

  // Reject URLs
  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Security restriction: URLs are not allowed: "${trimmed}"`);
  }

  // Reject network/UNC paths
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    throw new Error(`Security restriction: Network UNC paths are not allowed: "${trimmed}"`);
  }

  const resolved = path.resolve(baseDir, trimmed);
  const dataDir = path.resolve(baseDir, 'data');

  // Enforce location within data directory
  const relative = path.relative(dataDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Security restriction: Audio file must reside inside data/ directory. Got: "${resolved}"`);
  }

  // Check file exists
  if (!fs.existsSync(resolved)) {
    throw new Error(`Audio file does not exist: "${resolved}"`);
  }

  // Supported media extensions
  const ext = path.extname(resolved).toLowerCase();
  const allowedExts = ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'];
  if (!allowedExts.includes(ext)) {
    throw new Error(`Unsupported media format: "${ext}". Supported: ${allowedExts.join(', ')}`);
  }

  return resolved;
}

export async function runTranscriptionCli(options: TranscribeOptions): Promise<number> {
  const validatedPath = validateInputFilePath(options.inputFile);

  const pythonVenvExe = process.platform === 'win32'
    ? path.resolve('.venv', 'Scripts', 'python.exe')
    : path.resolve('.venv', 'bin', 'python');

  if (!fs.existsSync(pythonVenvExe)) {
    throw new Error(`Python virtual environment not found at "${pythonVenvExe}". Run "python -m venv .venv" and install requirements.`);
  }

  const scriptPath = path.resolve('scripts', 'transcribe.py');

  const args = [
    scriptPath,
    '--input', validatedPath,
    '--model', options.model || 'small',
    '--device', options.device || 'cpu',
    '--compute_type', options.computeType || 'int8',
    '--language', options.language || 'es',
    '--beam_size', '5',
    '--vad_filter'
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonVenvExe, args, { stdio: 'inherit' });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(0);
      } else {
        reject(new Error(`Transcription process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// CLI entry point
if (process.argv[1]?.endsWith('transcribe-cli.ts') || process.argv[1]?.endsWith('transcribe-cli.js')) {
  const args = process.argv.slice(2);
  let inputFile = '';
  let model = 'small';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputFile = args[i + 1]!;
      i++;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1]!;
      i++;
    }
  }

  if (!inputFile) {
    // Default fallback to 5min capture test
    inputFile = './data/audio/capture-test-5min-16khz.wav';
  }

  runTranscriptionCli({ inputFile, model })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ Transcription Error:', err.message);
      process.exit(1);
    });
}
