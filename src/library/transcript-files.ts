/**
 * Reading faster-whisper output (data/transcripts/<id>/<id>.json) and turning it
 * into the timestamped text the AI prompts consume.
 */

import fs from 'node:fs';
import { formatClock } from '../utils/time.js';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

export interface WhisperTranscript {
  recordingId: string;
  model: string;
  language: string;
  durationSeconds: number;
  timestamp: string;
  segments: TranscriptSegment[];
}

/** Whisper's own placeholder for empty segments (see scripts/transcribe.py) */
const PLACEHOLDER = '[ininteligible]';

/** Segments Whisper is fairly sure contain no speech are usually hallucinations. */
const NO_SPEECH_THRESHOLD = 0.85;

export function parseWhisperJson(raw: string): WhisperTranscript {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('El JSON de transcripción no es válido.');
  }
  if (!data || !Array.isArray(data.segments)) {
    throw new Error('El JSON de transcripción no contiene "segments".');
  }

  const segments: TranscriptSegment[] = [];
  for (const s of data.segments) {
    if (typeof s?.text !== 'string' || typeof s?.start !== 'number' || typeof s?.end !== 'number') continue;
    segments.push({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
      avg_logprob: typeof s.avg_logprob === 'number' ? s.avg_logprob : undefined,
      no_speech_prob: typeof s.no_speech_prob === 'number' ? s.no_speech_prob : undefined,
    });
  }

  const last = segments[segments.length - 1];
  return {
    recordingId: String(data.recordingId ?? ''),
    model: String(data.model ?? ''),
    language: String(data.detectedLanguage ?? data.language ?? ''),
    durationSeconds: Number(data.audioDurationSeconds ?? last?.end ?? 0),
    timestamp: String(data.timestamp ?? ''),
    segments,
  };
}

export function readWhisperJson(filePath: string): WhisperTranscript {
  return parseWhisperJson(fs.readFileSync(filePath, 'utf8'));
}

/** Drop empty, placeholder and probable-hallucination segments before spending tokens on them. */
export function cleanSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter((s) => {
    if (!s.text || s.text === PLACEHOLDER) return false;
    if (s.no_speech_prob !== undefined && s.no_speech_prob >= NO_SPEECH_THRESHOLD) return false;
    return true;
  });
}

/**
 * One line per segment: "[14:20] texto". Consecutive segments closer than `mergeGapSeconds`
 * are grouped so the prompt carries a timestamp roughly every `windowSeconds`.
 */
export function toTimestampedText(
  segments: TranscriptSegment[],
  options: { windowSeconds?: number } = {}
): string {
  const windowSeconds = options.windowSeconds ?? 20;
  const lines: string[] = [];
  let bucketStart = -Infinity;
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) lines.push(`[${formatClock(bucketStart)}] ${current.join(' ')}`);
    current = [];
  };

  for (const seg of cleanSegments(segments)) {
    if (seg.start - bucketStart >= windowSeconds) {
      flush();
      bucketStart = seg.start;
    }
    current.push(seg.text);
  }
  flush();
  return lines.join('\n');
}

function vttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(rest, 3)}`;
}

/** WebVTT built from stored segments, so subtitles never depend on the .vtt file still existing. */
export function segmentsToVtt(segments: { start: number; end: number; text: string }[]): string {
  const cues = segments
    .filter((s) => s.text && s.text !== PLACEHOLDER)
    .map((s) => `${vttTime(s.start)} --> ${vttTime(Math.max(s.end, s.start + 0.2))}\n${s.text.replace(/-->/g, '→')}`);
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
