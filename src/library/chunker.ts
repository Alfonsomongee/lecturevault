/**
 * Chunking for retrieval: transcript segments → ~1 minute windows with overlap,
 * notes markdown → paragraphs. Every chunk keeps the media time it came from so
 * answers can cite "Clase 3 · 14:20" and jump to the audio.
 */

import { cleanSegments, type TranscriptSegment } from './transcript-files.js';
import type { ChunkInput } from '../database/StudyRepository.js';
import { parseClock } from '../utils/time.js';

export interface ChunkOptions {
  /** Target words per chunk (default 170 ≈ 70 s of speech) */
  targetWords?: number;
  /** Segments repeated at the start of the next chunk (default 1) */
  overlapSegments?: number;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function chunkSegments(segments: TranscriptSegment[], options: ChunkOptions = {}): ChunkInput[] {
  const targetWords = options.targetWords ?? 170;
  const overlap = options.overlapSegments ?? 1;
  const clean = cleanSegments(segments);
  const chunks: ChunkInput[] = [];

  let i = 0;
  while (i < clean.length) {
    let words = 0;
    let j = i;
    while (j < clean.length && (words < targetWords || j === i)) {
      words += wordCount(clean[j]!.text);
      j++;
    }
    const slice = clean.slice(i, j);
    chunks.push({
      source: 'transcript',
      start_ms: Math.round(slice[0]!.start * 1000),
      end_ms: Math.round(slice[slice.length - 1]!.end * 1000),
      text: slice.map((s) => s.text).join(' '),
    });
    if (j >= clean.length) break;
    // step forward, keeping `overlap` segments of context (but always make progress)
    i = Math.max(i + 1, j - overlap);
  }
  return chunks;
}

const CLOCK_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

/** Split generated notes into paragraph chunks; start_ms is the first [mm:ss] tag found (or inherited). */
export function chunkNotes(markdown: string, maxChars = 900): ChunkInput[] {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: ChunkInput[] = [];
  let lastMs = 0;
  let buffer = '';
  let bufferMs = 0;
  let bufferHasTag = false;

  const flush = () => {
    if (buffer.trim()) {
      chunks.push({ source: 'notes', start_ms: bufferMs, end_ms: bufferMs, text: buffer.trim() });
    }
    buffer = '';
    bufferHasTag = false;
  };

  for (const block of blocks) {
    const match = new RegExp(CLOCK_RE.source).exec(block);
    const seconds = match ? parseClock(match[1]!) : null;
    if (seconds !== null) lastMs = seconds * 1000;

    if (buffer && buffer.length + block.length > maxChars) flush();
    // A chunk starts at the first tag it contains; until then it inherits the last known time.
    if (!buffer || (!bufferHasTag && seconds !== null)) bufferMs = lastMs;
    if (seconds !== null) bufferHasTag = true;
    buffer += (buffer ? '\n\n' : '') + block;
  }
  flush();
  return chunks;
}
