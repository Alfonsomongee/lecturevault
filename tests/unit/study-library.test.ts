import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { LATEST_SCHEMA_VERSION } from '../../src/database/migrations.js';
import { StudyRepository } from '../../src/database/StudyRepository.js';
import { TranscriptIngestor } from '../../src/library/TranscriptIngestor.js';
import { chunkSegments, chunkNotes } from '../../src/library/chunker.js';
import { toTimestampedText, cleanSegments } from '../../src/library/transcript-files.js';
import { SearchIndex, tokenize, MARK_OPEN } from '../../src/search/SearchIndex.js';

const logger = pino({ level: 'silent' });

function whisperJson(id: string, segments: [number, number, string, number?][]) {
  return JSON.stringify({
    recordingId: id,
    model: 'small',
    detectedLanguage: 'es',
    audioDurationSeconds: segments[segments.length - 1]![1],
    timestamp: '2026-03-02T10:00:00Z',
    segments: segments.map(([start, end, text, nsp], i) => ({
      id: i, start, end, text, avg_logprob: -0.2, no_speech_prob: nsp ?? 0.01,
    })),
  });
}

describe('study library', () => {
  let tmp: string;
  let db: DatabaseManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-study-'));
    db = new DatabaseManager(path.join(tmp, 'test.db'), logger);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeTranscript(id: string, segs: [number, number, string, number?][], notes?: string) {
    const dir = path.join(tmp, 'transcripts', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), whisperJson(id, segs));
    if (notes) fs.writeFileSync(path.join(dir, `${id}.clean.md`), notes);
  }

  describe('migrations', () => {
    it('upgrades a Milestone-1 database without losing rows', () => {
      const legacyPath = path.join(tmp, 'legacy.db');
      const legacy = new Database(legacyPath);
      legacy.exec(`CREATE TABLE recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, collab_id TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, duration_seconds INTEGER NOT NULL DEFAULT 0,
        playback_url TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','seen','processed')));
        INSERT INTO recordings (collab_id, title, created_at) VALUES ('c1', 'Clase vieja', '2025-01-01');`);
      legacy.close();

      const upgraded = new DatabaseManager(legacyPath, logger);
      const rec = upgraded.getRecordingByCollabId('c1')!;
      expect(rec.title).toBe('Clase vieja');
      expect(rec.course).toBe('');
      expect(rec.transcript_id).toBeNull();
      expect(upgraded.handle.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      upgraded.close();
    });

    it('is idempotent when reopened', () => {
      db.close();
      db = new DatabaseManager(path.join(tmp, 'test.db'), logger);
      expect(db.handle.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    });

    it('does not overwrite a course with an empty value on re-sync', () => {
      db.upsertRecording({ collabId: 'a', title: 'T', createdAt: '2026-01-01', durationSeconds: 60, playbackUrl: '', course: 'Ansys' });
      db.upsertRecording({ collabId: 'a', title: 'T2', createdAt: '2026-01-01', durationSeconds: 60, playbackUrl: '' });
      expect(db.getRecordingByCollabId('a')!.course).toBe('Ansys');
      expect(db.getRecordingByCollabId('a')!.title).toBe('T2');
    });
  });

  describe('transcript ingestion', () => {
    const segs: [number, number, string, number?][] = [
      [0, 5, 'Buenas tardes, ¿se me escucha bien?'],
      [5, 12, 'Hoy vamos a definir las restricciones en Ansys antes del mallado.'],
      [12, 20, 'ruido fantasma', 0.97],
      [860, 870, 'La práctica de CYPE pesa un treinta por ciento de la nota.'],
    ];

    it('creates a local recording, segments, chunks and imports notes', () => {
      writeTranscript('clase_ansys', segs, '# Clase\n\n## Mallado [14:20]\n\nTexto del mallado.');
      const ingestor = new TranscriptIngestor(db, tmp, logger);
      const result = ingestor.ingestAll({ course: 'Simulación' });

      expect(result.created).toBe(1);
      expect(result.importedNotes).toBe(1);
      const rec = db.getRecordingByTranscriptId('clase_ansys')!;
      expect(rec.course).toBe('Simulación');
      expect(rec.status).toBe('processed');
      expect(ingestor.study.getSegments(rec.id)).toHaveLength(4);
      expect(ingestor.study.getNotes(rec.id)!.markdown).toContain('Mallado');
      const chunks = ingestor.study.getChunks({ recordingId: rec.id });
      expect(chunks.some((c) => c.source === 'notes' && c.start_ms === 860_000)).toBe(true);
    });

    it('links to an existing Collab2 recording by sanitized id instead of duplicating', () => {
      db.upsertRecording({ collabId: 'abc-123', title: 'Clase 1', createdAt: '2026-03-01', durationSeconds: 900, playbackUrl: '' });
      writeTranscript('abc-123', segs);
      const ingestor = new TranscriptIngestor(db, tmp, logger);
      const result = ingestor.ingestAll();
      expect(result.linked).toBe(1);
      expect(result.created).toBe(0);
      expect(db.getAllRecordings()).toHaveLength(1);
    });

    it('is idempotent and keeps embeddings when nothing changed', () => {
      writeTranscript('c1', segs);
      const ingestor = new TranscriptIngestor(db, tmp, logger);
      ingestor.ingestAll();
      const rec = db.getRecordingByTranscriptId('c1')!;
      const [chunk] = ingestor.study.getChunks({ recordingId: rec.id });
      ingestor.study.setEmbeddings([{ id: chunk!.id, vector: new Float32Array([1, 0]) }], 'test');

      const again = ingestor.ingestAll();
      expect(again.updatedSegments).toBe(0);
      expect(ingestor.study.countChunksMissingEmbedding()).toBe(ingestor.study.getChunks().length - 1);
    });

    it('rejects unsafe folder names and reports bad JSON without aborting the batch', () => {
      writeTranscript('good', segs);
      fs.mkdirSync(path.join(tmp, 'transcripts', 'bad'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'transcripts', 'bad', 'bad.json'), '{not json');
      const ingestor = new TranscriptIngestor(db, tmp, logger);
      const result = ingestor.ingestAll();
      expect(result.created).toBe(1);
      expect(result.skipped).toHaveLength(1);
      expect(() => ingestor.ingestOne('../etc')).toThrow();
    });
  });

  describe('transcript text helpers', () => {
    it('drops placeholders and probable hallucinations, groups by time window', () => {
      const text = toTimestampedText([
        { start: 0, end: 5, text: 'Hola a todos' },
        { start: 6, end: 9, text: '[ininteligible]' },
        { start: 10, end: 14, text: 'seguimos con el tema', no_speech_prob: 0.1 },
        { start: 70, end: 75, text: 'gracias por ver', no_speech_prob: 0.99 },
        { start: 3725, end: 3730, text: 'ya en la segunda hora' },
      ]);
      expect(text).toBe('[00:00] Hola a todos seguimos con el tema\n[1:02:05] ya en la segunda hora');
      expect(cleanSegments([{ start: 0, end: 1, text: '' }])).toHaveLength(0);
    });

    it('chunks segments with overlap and never loops forever on long segments', () => {
      const long = 'palabra '.repeat(400).trim();
      const chunks = chunkSegments([
        { start: 0, end: 60, text: long },
        { start: 60, end: 70, text: 'corto uno' },
        { start: 70, end: 80, text: 'corto dos' },
      ]);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]!.start_ms).toBe(0);
      expect(chunks.at(-1)!.end_ms).toBe(80_000);
    });

    it('chunks notes keeping the nearest [mm:ss] tag', () => {
      const chunks = chunkNotes('# T\n\n## A [01:30]\n\nuno\n\n' + 'x'.repeat(950) + '\n\n## B [1:02:00]\n\ndos');
      expect(chunks[0]!.start_ms).toBe(90_000);
      expect(chunks.at(-1)!.start_ms).toBe(3_720_000);
    });
  });

  describe('search', () => {
    let search: SearchIndex;
    let recId: number;

    beforeEach(() => {
      writeTranscript('s1', [
        [0, 5, 'Definimos las restricciones en Ansys antes del mallado.'],
        [860, 870, 'La construcción de la práctica de CYPE pesa un 30%.'],
        [900, 910, 'Cuidado con esta fórmula del momento flector.'],
      ], '# Apuntes\n\n## Evaluación [14:20]\n\nLa práctica de CYPE pesa el 30% de la nota final.');
      new TranscriptIngestor(db, tmp, logger).ingestAll();
      recId = db.getRecordingByTranscriptId('s1')!.id;
      search = new SearchIndex(db.handle);
    });

    it('ignores accents and case', () => {
      const res = search.search('CONSTRUCCION');
      expect(res.hits[0]!.startMs).toBe(860_000);
      expect(res.hits[0]!.snippet).toContain(MARK_OPEN);
    });

    it('supports prefix on the last word and returns timestamps', () => {
      const res = search.search('restric');
      expect(res.hits.some((h) => h.source === 'transcript' && h.startMs === 0)).toBe(true);
    });

    it('finds notes as well as transcript', () => {
      const res = search.search('cype');
      expect(new Set(res.hits.map((h) => h.source))).toEqual(new Set(['transcript', 'notes']));
    });

    it('cleans markdown in note hits and jumps to the nearest [mm:ss] tag', () => {
      const hit = search.search('cype').hits.find((h) => h.source === 'notes')!;
      expect(hit.snippet).not.toMatch(/[#*]/);
      expect(hit.startMs).toBe(860_000); // the [14:20] tag shown in the snippet
    });

    it('tolerates ASR typos and reports the correction', () => {
      const res = search.search('ansis');
      expect(res.corrected).toEqual([{ from: 'ansis', to: 'ansys' }]);
      expect(res.hits.length).toBeGreaterThan(0);
    });

    it('never throws on hostile FTS syntax', () => {
      for (const q of ['"', 'a OR', 'NEAR(', '* *', '-', 'x:y', "'; DROP TABLE segments;--", '   ']) {
        expect(() => search.search(q)).not.toThrow();
      }
      expect(tokenize('Fórmula-del "momento"')).toEqual(['formula', 'del', 'momento']);
    });

    it('filters by course and recording', () => {
      db.setCourse(recId, 'Estructuras');
      expect(search.search('cype', { course: 'Estructuras' }).hits.length).toBeGreaterThan(0);
      expect(search.search('cype', { course: 'Otra' }).hits).toHaveLength(0);
      expect(search.search('cype', { recordingId: recId + 99 }).hits).toHaveLength(0);
    });

    it('stays consistent after segments are replaced (triggers)', () => {
      const study = new StudyRepository(db.handle);
      study.replaceSegments(recId, [{ start: 0, end: 3, text: 'contenido totalmente nuevo' }]);
      expect(search.search('mallado').hits.filter((h) => h.source === 'transcript')).toHaveLength(0);
      expect(search.search('nuevo').hits.length).toBe(1);
    });
  });

  describe('alerts and flashcards', () => {
    let study: StudyRepository;
    let recId: number;

    beforeEach(() => {
      db.upsertRecording({ collabId: 'r', title: 'R', createdAt: '2026-03-02', durationSeconds: 60, playbackUrl: '' });
      recId = db.getRecordingByCollabId('r')!.id;
      study = new StudyRepository(db.handle);
    });

    it('keeps user decisions when AI alerts are regenerated', () => {
      study.replaceAlerts(recId, [
        { kind: 'deadline', text: 'Foro hasta el 20', t_ms: 1000, due_date: '2026-03-20' },
        { kind: 'exam', text: 'Entra en el examen', t_ms: 2000 },
      ]);
      const [first] = study.listAlerts({ recordingId: recId });
      study.updateAlert(first!.id, { confirmed: true });

      const inserted = study.replaceAlerts(recId, [
        { kind: 'deadline', text: 'Foro hasta el 20 (reformulado)', t_ms: 1000, due_date: '2026-03-20' },
        { kind: 'warning', text: 'Cuidado con la fórmula', t_ms: 3000 },
      ]);
      const all = study.listAlerts({ recordingId: recId });
      expect(inserted).toBe(1); // the confirmed deadline@1000 is not duplicated
      expect(all.map((a) => a.kind).sort()).toEqual(['deadline', 'warning']);
      expect(all.find((a) => a.kind === 'deadline')!.confirmed).toBe(1);
    });

    it('does not duplicate flashcards and preserves review progress', () => {
      study.upsertFlashcards(recId, [{ kind: 'basic', front: '¿Qué es el mallado?', back: 'Discretización' }]);
      const [card] = study.listFlashcards({ recordingId: recId });
      study.reviewFlashcard(card!.id, true);

      const inserted = study.upsertFlashcards(recId, [{ kind: 'basic', front: '¿Qué es el mallado?  ', back: 'otra' }]);
      expect(inserted).toBe(0);
      const after = study.listFlashcards({ recordingId: recId });
      expect(after).toHaveLength(1);
      expect(after[0]!.box).toBe(1);
      expect(after[0]!.reps).toBe(1);
    });

    it('Leitner: right answers climb boxes and delay review, wrong resets', () => {
      study.upsertFlashcards(recId, [{ kind: 'basic', front: 'Q', back: 'A' }]);
      const id = study.listFlashcards()[0]!.id;
      expect(study.listFlashcards({ dueOnly: true })).toHaveLength(1);
      study.reviewFlashcard(id, true);
      study.reviewFlashcard(id, true);
      expect(study.listFlashcards({ dueOnly: true })).toHaveLength(0);
      expect(study.reviewFlashcard(id, false)!.box).toBe(0);
      expect(study.listFlashcards({ dueOnly: true })).toHaveLength(1);
    });

    it('overview reports per-recording study progress', () => {
      study.saveNotes(recId, '# n', 'm', '2');
      study.upsertFlashcards(recId, [{ kind: 'basic', front: 'Q', back: 'A' }]);
      study.replaceAlerts(recId, [{ kind: 'exam', text: 'x', t_ms: 0 }]);
      const [row] = study.getOverview();
      expect(row).toMatchObject({ has_notes: 1, flashcard_count: 1, flashcards_due: 1, alert_count: 1 });
    });
  });
});
