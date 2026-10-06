/**
 * Persistence for everything the study copilot derives from a recording:
 * transcript segments (+FTS5), notes, alerts, flashcards, glossary and RAG chunks.
 *
 * Shares the DatabaseManager connection. Segments/chunks/notes can always be rebuilt
 * from the files under data/; alert confirmations and flashcard reviews are user
 * state that only lives here, so they are preserved when AI output is regenerated.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { TranscriptSegment } from '../library/transcript-files.js';

export type AlertKind = 'exam' | 'deadline' | 'warning' | 'formula' | 'grading';
export type Confidence = 'high' | 'medium' | 'low';

export interface SegmentRow {
  id: number;
  recording_id: number;
  idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
  avg_logprob: number | null;
  no_speech_prob: number | null;
}

export interface NotesRow {
  id: number;
  recording_id: number;
  kind: string;
  markdown: string;
  model: string;
  prompt_version: string;
  created_at: string;
}

export interface AlertInput {
  kind: AlertKind;
  text: string;
  quote?: string;
  t_ms: number;
  due_date?: string | null;
  date_text?: string;
  confidence?: Confidence;
}

export interface AlertRow extends Required<Omit<AlertInput, 'due_date'>> {
  id: number;
  recording_id: number;
  due_date: string | null;
  confirmed: number;
  dismissed: number;
  created_at: string;
  recording_title?: string;
  course?: string;
  recording_date?: string;
}

export interface FlashcardInput {
  kind: 'basic' | 'cloze';
  front: string;
  back: string;
  tag?: string;
  t_ms?: number;
}

export interface FlashcardRow {
  id: number;
  recording_id: number;
  kind: 'basic' | 'cloze';
  front: string;
  back: string;
  tag: string;
  t_ms: number;
  guid: string;
  box: number;
  reps: number;
  due_at: string;
  recording_title?: string;
  course?: string;
}

export interface GlossaryInput {
  term: string;
  definition: string;
  t_ms?: number;
}

export interface GlossaryRow {
  id: number;
  recording_id: number;
  course: string;
  term: string;
  definition: string;
  t_ms: number;
}

export interface ChunkInput {
  source: 'transcript' | 'notes';
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface ChunkRow {
  id: number;
  recording_id: number;
  source: 'transcript' | 'notes';
  start_ms: number;
  end_ms: number;
  text: string;
  embedding: Buffer | null;
  embedding_model: string | null;
}

export interface RecordingOverview {
  id: number;
  collab_id: string;
  title: string;
  created_at: string;
  duration_seconds: number;
  playback_url: string;
  status: string;
  course: string;
  transcript_id: string | null;
  segment_count: number;
  has_notes: number;
  alert_count: number;
  flashcard_count: number;
  flashcards_due: number;
}

/** Leitner boxes: days until the next review after answering correctly from that box. */
export const LEITNER_DAYS = [0, 1, 3, 7, 21];

export class StudyRepository {
  constructor(private readonly db: Database.Database) {}

  // ── Segments ────────────────────────────────────────────────────────────

  replaceSegments(recordingId: number, segments: TranscriptSegment[]): number {
    const insert = this.db.prepare(
      `INSERT INTO segments (recording_id, idx, start_ms, end_ms, text, avg_logprob, no_speech_prob)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM segments WHERE recording_id = ?').run(recordingId);
      segments.forEach((s, idx) => {
        insert.run(
          recordingId,
          idx,
          Math.round(s.start * 1000),
          Math.round(s.end * 1000),
          s.text,
          s.avg_logprob ?? null,
          s.no_speech_prob ?? null
        );
      });
    });
    run();
    return segments.length;
  }

  getSegments(recordingId: number): SegmentRow[] {
    return this.db
      .prepare('SELECT * FROM segments WHERE recording_id = ? ORDER BY idx')
      .all(recordingId) as SegmentRow[];
  }

  // ── Notes ───────────────────────────────────────────────────────────────

  saveNotes(recordingId: number, markdown: string, model: string, promptVersion: string, kind = 'clean'): void {
    this.db
      .prepare(
        `INSERT INTO notes (recording_id, kind, markdown, model, prompt_version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(recording_id, kind) DO UPDATE SET
           markdown = excluded.markdown, model = excluded.model,
           prompt_version = excluded.prompt_version, created_at = datetime('now')`
      )
      .run(recordingId, kind, markdown, model, promptVersion);
  }

  getNotes(recordingId: number, kind = 'clean'): NotesRow | undefined {
    return this.db
      .prepare('SELECT * FROM notes WHERE recording_id = ? AND kind = ?')
      .get(recordingId, kind) as NotesRow | undefined;
  }

  // ── Alerts ──────────────────────────────────────────────────────────────

  /**
   * Replace the AI-proposed alerts for a recording. Alerts the user already confirmed or
   * dismissed are kept (and never duplicated) so re-running the AI never loses decisions.
   */
  replaceAlerts(recordingId: number, alerts: AlertInput[]): number {
    const insert = this.db.prepare(
      `INSERT INTO alerts (recording_id, kind, text, quote, t_ms, due_date, date_text, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM alerts WHERE recording_id = ? AND confirmed = 0 AND dismissed = 0').run(recordingId);
      const kept = this.db
        .prepare('SELECT kind, t_ms FROM alerts WHERE recording_id = ?')
        .all(recordingId) as { kind: string; t_ms: number }[];
      const seen = new Set(kept.map((a) => `${a.kind}@${a.t_ms}`));

      for (const a of alerts) {
        const key = `${a.kind}@${a.t_ms}`;
        if (seen.has(key)) continue;
        seen.add(key);
        insert.run(
          recordingId,
          a.kind,
          a.text,
          a.quote ?? '',
          a.t_ms,
          a.due_date ?? null,
          a.date_text ?? '',
          a.confidence ?? 'medium'
        );
        inserted++;
      }
    });
    run();
    return inserted;
  }

  listAlerts(filter: { recordingId?: number; course?: string; includeDismissed?: boolean } = {}): AlertRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.recordingId !== undefined) {
      where.push('a.recording_id = ?');
      params.push(filter.recordingId);
    }
    if (filter.course) {
      where.push('r.course = ?');
      params.push(filter.course);
    }
    if (!filter.includeDismissed) where.push('a.dismissed = 0');

    return this.db
      .prepare(
        `SELECT a.*, r.title AS recording_title, r.course AS course, r.created_at AS recording_date
         FROM alerts a JOIN recordings r ON r.id = a.recording_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY (a.due_date IS NULL), a.due_date, r.created_at DESC, a.t_ms`
      )
      .all(...params) as AlertRow[];
  }

  getAlert(id: number): AlertRow | undefined {
    return this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
  }

  updateAlert(id: number, patch: { confirmed?: boolean; dismissed?: boolean; due_date?: string | null }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.confirmed !== undefined) {
      sets.push('confirmed = ?');
      params.push(patch.confirmed ? 1 : 0);
    }
    if (patch.dismissed !== undefined) {
      sets.push('dismissed = ?');
      params.push(patch.dismissed ? 1 : 0);
    }
    if (patch.due_date !== undefined) {
      sets.push('due_date = ?');
      params.push(patch.due_date);
    }
    if (sets.length === 0) return false;
    params.push(id);
    return this.db.prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
  }

  // ── Flashcards ──────────────────────────────────────────────────────────

  static cardGuid(recordingId: number, front: string): string {
    return createHash('sha1').update(`${recordingId}\u0000${front.trim().toLowerCase()}`).digest('hex').slice(0, 20);
  }

  /** Insert new cards; cards that already exist (same guid) keep their review progress. */
  upsertFlashcards(recordingId: number, cards: FlashcardInput[]): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO flashcards (recording_id, kind, front, back, tag, t_ms, guid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    const run = this.db.transaction(() => {
      for (const c of cards) {
        const info = insert.run(
          recordingId,
          c.kind,
          c.front,
          c.back,
          c.tag ?? '',
          c.t_ms ?? 0,
          StudyRepository.cardGuid(recordingId, c.front)
        );
        inserted += info.changes;
      }
    });
    run();
    return inserted;
  }

  listFlashcards(filter: { recordingId?: number; course?: string; dueOnly?: boolean; limit?: number } = {}): FlashcardRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.recordingId !== undefined) {
      where.push('f.recording_id = ?');
      params.push(filter.recordingId);
    }
    if (filter.course) {
      where.push('r.course = ?');
      params.push(filter.course);
    }
    if (filter.dueOnly) where.push("f.due_at <= datetime('now')");

    return this.db
      .prepare(
        `SELECT f.*, r.title AS recording_title, r.course AS course
         FROM flashcards f JOIN recordings r ON r.id = f.recording_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY f.due_at, f.id
         LIMIT ?`
      )
      .all(...params, filter.limit ?? 500) as FlashcardRow[];
  }

  /** Leitner review: correct moves up a box (longer interval), wrong goes back to box 0. */
  reviewFlashcard(id: number, correct: boolean): FlashcardRow | undefined {
    const card = this.db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id) as FlashcardRow | undefined;
    if (!card) return undefined;
    const box = correct ? Math.min(card.box + 1, LEITNER_DAYS.length - 1) : 0;
    const days = correct ? LEITNER_DAYS[box]! : 0;
    this.db
      .prepare(
        `UPDATE flashcards SET box = ?, reps = reps + 1,
           due_at = datetime('now', ?) WHERE id = ?`
      )
      .run(box, `+${days} days`, id);
    return this.db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id) as FlashcardRow;
  }

  // ── Glossary ────────────────────────────────────────────────────────────

  upsertGlossary(recordingId: number, course: string, terms: GlossaryInput[]): number {
    const insert = this.db.prepare(
      `INSERT INTO glossary (recording_id, course, term, definition, t_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(course, term) DO UPDATE SET
         definition = CASE WHEN length(excluded.definition) > length(glossary.definition)
                           THEN excluded.definition ELSE glossary.definition END`
    );
    let n = 0;
    const run = this.db.transaction(() => {
      for (const t of terms) {
        const term = t.term.trim();
        if (!term) continue;
        insert.run(recordingId, course, term, t.definition.trim(), t.t_ms ?? 0);
        n++;
      }
    });
    run();
    return n;
  }

  listGlossary(course?: string): GlossaryRow[] {
    return (
      course === undefined
        ? this.db.prepare('SELECT * FROM glossary ORDER BY course, term COLLATE NOCASE').all()
        : this.db.prepare('SELECT * FROM glossary WHERE course = ? ORDER BY term COLLATE NOCASE').all(course)
    ) as GlossaryRow[];
  }

  // ── RAG chunks ──────────────────────────────────────────────────────────

  replaceChunks(recordingId: number, chunks: ChunkInput[]): number[] {
    const insert = this.db.prepare(
      'INSERT INTO chunks (recording_id, source, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
    );
    const ids: number[] = [];
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunks WHERE recording_id = ?').run(recordingId);
      for (const c of chunks) {
        ids.push(Number(insert.run(recordingId, c.source, c.start_ms, c.end_ms, c.text).lastInsertRowid));
      }
    });
    run();
    return ids;
  }

  setEmbeddings(items: { id: number; vector: Float32Array }[], model: string): void {
    const update = this.db.prepare('UPDATE chunks SET embedding = ?, embedding_model = ? WHERE id = ?');
    const run = this.db.transaction(() => {
      for (const { id, vector } of items) {
        update.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), model, id);
      }
    });
    run();
  }

  getChunks(filter: { course?: string; recordingId?: number } = {}): (ChunkRow & { recording_title: string; course: string })[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.course) {
      where.push('r.course = ?');
      params.push(filter.course);
    }
    if (filter.recordingId !== undefined) {
      where.push('c.recording_id = ?');
      params.push(filter.recordingId);
    }
    return this.db
      .prepare(
        `SELECT c.*, r.title AS recording_title, r.course AS course
         FROM chunks c JOIN recordings r ON r.id = c.recording_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
      )
      .all(...params) as (ChunkRow & { recording_title: string; course: string })[];
  }

  countChunksMissingEmbedding(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM chunks WHERE embedding IS NULL').get() as { n: number }).n;
  }

  getChunksMissingEmbedding(): { id: number; text: string }[] {
    return this.db.prepare('SELECT id, text FROM chunks WHERE embedding IS NULL').all() as { id: number; text: string }[];
  }

  // ── Library overview ────────────────────────────────────────────────────

  getOverview(filter: { status?: string; course?: string } = {}): RecordingOverview[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('r.status = ?');
      params.push(filter.status);
    }
    if (filter.course !== undefined) {
      where.push('r.course = ?');
      params.push(filter.course);
    }
    return this.db
      .prepare(
        `SELECT r.id, r.collab_id, r.title, r.created_at, r.duration_seconds, r.playback_url,
                r.status, r.course, r.transcript_id,
                (SELECT count(*) FROM segments s WHERE s.recording_id = r.id) AS segment_count,
                EXISTS(SELECT 1 FROM notes n WHERE n.recording_id = r.id) AS has_notes,
                (SELECT count(*) FROM alerts a WHERE a.recording_id = r.id AND a.dismissed = 0) AS alert_count,
                (SELECT count(*) FROM flashcards f WHERE f.recording_id = r.id) AS flashcard_count,
                (SELECT count(*) FROM flashcards f WHERE f.recording_id = r.id AND f.due_at <= datetime('now')) AS flashcards_due
         FROM recordings r
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY r.created_at DESC`
      )
      .all(...params) as RecordingOverview[];
  }

  getStudyStats(): { transcribed: number; withNotes: number; alerts: number; flashcards: number; flashcardsDue: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      transcribed: n('SELECT count(DISTINCT recording_id) AS n FROM segments'),
      withNotes: n('SELECT count(DISTINCT recording_id) AS n FROM notes'),
      alerts: n('SELECT count(*) AS n FROM alerts WHERE dismissed = 0'),
      flashcards: n('SELECT count(*) AS n FROM flashcards'),
      flashcardsDue: n("SELECT count(*) AS n FROM flashcards WHERE due_at <= datetime('now')"),
    };
  }
}
