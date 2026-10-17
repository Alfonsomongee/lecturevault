/**
 * Grounding: check that what the model claims actually appears in the transcript, and snap
 * its timestamps to the real moment. This is what keeps flashcards and alerts from being
 * hallucinations and keeps "jump to 14:20" accurate.
 */

import type { TranscriptSegment } from '../library/transcript-files.js';
import { tokenize } from '../search/SearchIndex.js';

const STOPWORDS = new Set([
  'este', 'esta', 'esto', 'estos', 'estas', 'para', 'pero', 'como', 'cuando', 'donde', 'entonces',
  'porque', 'sobre', 'entre', 'desde', 'hasta', 'tiene', 'tienen', 'puede', 'pueden', 'cada',
  'esos', 'esas', 'aqui', 'alli', 'solo', 'bien', 'muy', 'mas', 'tambien', 'segun', 'cual',
]);

/** Distinct, accent-folded words of 4+ letters that carry meaning. */
export function contentTokens(text: string): string[] {
  const out = new Set<string>();
  for (const tok of tokenize(text)) {
    if (tok.length >= 4 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return [...out];
}

// Alerts and flashcards are all located against the same transcript: tokenise it once, not per call
const tokenCache = new WeakMap<TranscriptSegment[], Set<string>[]>();
function segmentTokens(segments: TranscriptSegment[]): Set<string>[] {
  let cached = tokenCache.get(segments);
  if (!cached) {
    cached = segments.map((s) => new Set(contentTokens(s.text)));
    tokenCache.set(segments, cached);
  }
  return cached;
}

export interface Location {
  /** Fraction of the evidence's content words found in the best window (0-1) */
  score: number;
  /** Start of the best-matching window in ms, or the hint when nothing matched */
  startMs: number;
}

/**
 * Find where in the transcript `evidence` was said. Looks at sliding windows of 3 segments and
 * prefers the window closest to the model's own timestamp (`hintMs`) when scores tie.
 */
export function locateEvidence(evidence: string, segments: TranscriptSegment[], hintMs = 0): Location {
  const wanted = contentTokens(evidence);
  if (wanted.length < 2 || segments.length === 0) return { score: 0, startMs: hintMs };

  const segTokens = segmentTokens(segments);
  const WINDOW = 3;
  let best: (Location & { size: number; distance: number }) | null = null;

  // Candidates are windows of 1..3 consecutive segments. Highest coverage wins; among equals the
  // tightest window (so the time points at the segment that really holds the words), then the
  // one nearest to the model's own timestamp.
  for (let i = 0; i < segments.length; i++) {
    const window = new Set<string>();
    for (let size = 1; size <= WINDOW && i + size <= segments.length; size++) {
      segTokens[i + size - 1]!.forEach((t) => window.add(t));
      let hit = 0;
      for (const t of wanted) if (window.has(t)) hit++;
      const score = hit / wanted.length;
      if (score === 0) continue;

      const startMs = Math.round(segments[i]!.start * 1000);
      const distance = Math.abs(startMs - hintMs);
      const better =
        !best ||
        score > best.score + 1e-9 ||
        (Math.abs(score - best.score) <= 1e-9 && (size < best.size || (size === best.size && distance < best.distance)));
      if (better) best = { score, startMs, size, distance };
    }
  }
  return best ? { score: best.score, startMs: best.startMs } : { score: 0, startMs: hintMs };
}
