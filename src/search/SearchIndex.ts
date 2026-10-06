/**
 * Full-text search over transcript segments and notes (SQLite FTS5).
 *
 * - Accent/case-insensitive (unicode61 remove_diacritics 2): "construccion" finds "construcción".
 * - Safe: user text is turned into quoted FTS5 terms, so `-`, `"`, `:` can't cause syntax errors.
 * - Prefix on the last word ("restric" → "restricciones") for search-as-you-type.
 * - Typo/ASR tolerant: when a word isn't in the index, nearby words (edit distance ≤ 2) are
 *   substituted, so "ansis" still finds "Ansys".
 */

import type Database from 'better-sqlite3';

/** Control characters wrapped around matched words in snippets; the UI converts them to <mark>. */
export const MARK_OPEN = '\u0001';
export const MARK_CLOSE = '\u0002';

export interface SearchOptions {
  course?: string;
  recordingId?: number;
  limit?: number;
}

export interface SearchHit {
  source: 'transcript' | 'notes';
  recordingId: number;
  recordingTitle: string;
  course: string;
  startMs: number;
  /** Text with MARK_OPEN / MARK_CLOSE around matches */
  snippet: string;
  rank: number;
}

export interface SearchResponse {
  query: string;
  /** Words that were replaced by close matches from the index */
  corrected: { from: string; to: string }[];
  hits: SearchHit[];
}

/** lower-case + strip diacritics, mirroring what the FTS tokenizer does */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

export function tokenize(input: string): string[] {
  return fold(input).match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      rowMin = Math.min(rowMin, curr[j]!);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length]!;
}

export class SearchIndex {
  constructor(private readonly db: Database.Database) {}

  /** Build a safe FTS5 MATCH expression. `prefixLast` makes the final word a prefix query. */
  static buildMatch(tokens: string[], prefixLast = true): string | null {
    if (tokens.length === 0) return null;
    return tokens
      .map((t, i) => `"${t}"${prefixLast && i === tokens.length - 1 ? '*' : ''}`)
      .join(' ');
  }

  private termExists(token: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM segments_vocab WHERE term = ? LIMIT 1').get(token);
    if (row) return true;
    // also accept prefix matches so partial typing doesn't trigger corrections
    return !!this.db.prepare('SELECT 1 FROM segments_vocab WHERE term >= ? AND term < ? LIMIT 1').get(token, token + '￿');
  }

  private closestTerm(token: string): string | null {
    if (token.length < 4) return null;
    const maxDist = token.length <= 5 ? 1 : 2;
    const terms = this.db.prepare('SELECT term, doc FROM segments_vocab').all() as { term: string; doc: number }[];
    let best: { term: string; dist: number; doc: number } | null = null;
    for (const t of terms) {
      const dist = levenshtein(token, t.term, maxDist);
      if (dist > maxDist) continue;
      if (!best || dist < best.dist || (dist === best.dist && t.doc > best.doc)) {
        best = { term: t.term, dist, doc: t.doc };
      }
    }
    return best?.term ?? null;
  }

  search(input: string, options: SearchOptions = {}): SearchResponse {
    const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);
    let tokens = tokenize(input);
    const response: SearchResponse = { query: input, corrected: [], hits: [] };
    if (tokens.length === 0) return response;

    let hits = this.run(tokens, options, limit);

    // Nothing found: replace unknown words by their closest indexed neighbour and retry.
    if (hits.length === 0) {
      const fixed = tokens.map((tok, i) => {
        const isLast = i === tokens.length - 1;
        if (this.termExists(tok) || (isLast && tok.length < 3)) return tok;
        const near = this.closestTerm(tok);
        if (near && near !== tok) {
          response.corrected.push({ from: tok, to: near });
          return near;
        }
        return tok;
      });
      if (response.corrected.length > 0) {
        tokens = fixed;
        hits = this.run(tokens, options, limit);
      }
    }

    response.hits = hits;
    return response;
  }

  private run(tokens: string[], options: SearchOptions, limit: number): SearchHit[] {
    const match = SearchIndex.buildMatch(tokens);
    if (!match) return [];

    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.course) {
      filters.push('r.course = ?');
      params.push(options.course);
    }
    if (options.recordingId !== undefined) {
      filters.push('r.id = ?');
      params.push(options.recordingId);
    }
    const extra = filters.length ? ' AND ' + filters.join(' AND ') : '';

    const transcript = this.db
      .prepare(
        `SELECT 'transcript' AS source, r.id AS recordingId, r.title AS recordingTitle, r.course AS course,
                s.start_ms AS startMs,
                snippet(segments_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 18) AS snippet,
                bm25(segments_fts) AS rank
         FROM segments_fts
         JOIN segments s ON s.id = segments_fts.rowid
         JOIN recordings r ON r.id = s.recording_id
         WHERE segments_fts MATCH ?${extra}
         ORDER BY rank LIMIT ?`
      )
      .all(match, ...params, limit) as SearchHit[];

    const notes = this.db
      .prepare(
        `SELECT 'notes' AS source, r.id AS recordingId, r.title AS recordingTitle, r.course AS course,
                c.start_ms AS startMs,
                snippet(chunks_fts, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 24) AS snippet,
                bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid AND c.source = 'notes'
         JOIN recordings r ON r.id = c.recording_id
         WHERE chunks_fts MATCH ?${extra}
         ORDER BY rank LIMIT ?`
      )
      .all(match, ...params, Math.ceil(limit / 2)) as SearchHit[];

    // bm25 ranks are comparable within one index; interleave by rank, notes first on ties
    return [...notes, ...transcript].sort((a, b) => a.rank - b.rank).slice(0, limit);
  }
}
