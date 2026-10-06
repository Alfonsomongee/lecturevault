/**
 * Ingests files from data/transcripts/<id>/ into SQLite (segments, FTS, notes, RAG chunks)
 * and links each transcript folder to its recording.
 *
 * Idempotent: re-running only touches what changed, so embeddings (which cost API calls)
 * are not thrown away unless the transcript itself changed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { DatabaseManager } from '../database/DatabaseManager.js';
import { StudyRepository } from '../database/StudyRepository.js';
import { readWhisperJson } from './transcript-files.js';
import { chunkSegments, chunkNotes } from './chunker.js';
import { isSafeTranscriptId, sanitizeRecordingId } from '../utils/ids.js';
import type { RecordingRow } from '../types.js';

export interface IngestResult {
  scanned: number;
  linked: number;
  created: number;
  updatedSegments: number;
  importedNotes: number;
  skipped: string[];
}

export class TranscriptIngestor {
  readonly study: StudyRepository;

  constructor(
    private readonly db: DatabaseManager,
    private readonly dataDir: string,
    private readonly logger?: Logger
  ) {
    this.study = new StudyRepository(db.handle);
  }

  get transcriptsDir(): string {
    return path.join(this.dataDir, 'transcripts');
  }

  ingestAll(options: { course?: string } = {}): IngestResult {
    const result: IngestResult = { scanned: 0, linked: 0, created: 0, updatedSegments: 0, importedNotes: 0, skipped: [] };
    if (!fs.existsSync(this.transcriptsDir)) return result;

    // Recordings still waiting for a transcript folder, computed once for the whole run
    const candidates = this.db.getAllRecordings().filter((r) => !r.transcript_id);

    for (const entry of fs.readdirSync(this.transcriptsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        this.ingestOne(entry.name, result, options.course, candidates);
      } catch (err) {
        result.skipped.push(`${entry.name}: ${(err as Error).message}`);
        this.logger?.warn({ err, id: entry.name }, 'No se pudo ingerir la transcripción');
      }
    }
    return result;
  }

  /** Ingest one transcript folder by id. Returns the recording it belongs to. */
  ingestOne(transcriptId: string, result?: IngestResult, course?: string, candidates?: RecordingRow[]): RecordingRow {
    const acc = result ?? { scanned: 0, linked: 0, created: 0, updatedSegments: 0, importedNotes: 0, skipped: [] };
    if (!isSafeTranscriptId(transcriptId)) throw new Error('identificador no válido');

    const dir = path.join(this.transcriptsDir, transcriptId);
    const jsonPath = path.join(dir, `${transcriptId}.json`);
    if (!fs.existsSync(jsonPath)) throw new Error('falta el JSON de segmentos');

    acc.scanned++;
    const transcript = readWhisperJson(jsonPath);

    // 1. Find or create the recording this folder belongs to
    let recording = this.db.getRecordingByTranscriptId(transcriptId);
    if (!recording) {
      const pool = candidates ?? this.db.getAllRecordings().filter((r) => !r.transcript_id);
      // Prefer the exact Collab2 id; fall back to the title only when it is unambiguous
      const byId = pool.filter((r) => sanitizeRecordingId(r.collab_id) === transcriptId);
      const byTitle = pool.filter((r) => sanitizeRecordingId(r.title) === transcriptId);
      const match = byId.length === 1 ? byId[0] : byId.length === 0 && byTitle.length === 1 ? byTitle[0] : undefined;
      if (match) {
        this.db.setTranscriptId(match.id, transcriptId);
        recording = this.db.getRecordingById(match.id)!;
        if (candidates) candidates.splice(candidates.indexOf(match), 1);
        acc.linked++;
      }
    }
    if (!recording) {
      recording = this.db.createLocalRecording({
        transcriptId,
        title: transcriptId.replace(/[_-]+/g, ' ').trim() || transcriptId,
        createdAt: transcript.timestamp || fs.statSync(jsonPath).mtime.toISOString(),
        durationSeconds: transcript.durationSeconds,
        course,
      });
      acc.created++;
    } else if (course && !recording.course) {
      this.db.setCourse(recording.id, course);
    }

    // 2. Segments (+ transcript chunks) only when the transcript really changed
    const hash = createHash('sha1')
      .update(transcript.segments.map((s) => `${s.start}|${s.end}|${s.text}`).join('\n'))
      .digest('hex');
    const transcriptChanged = recording.segments_hash !== hash;
    if (transcriptChanged) {
      this.study.replaceSegments(recording.id, transcript.segments);
      this.study.replaceChunks(recording.id, 'transcript', chunkSegments(transcript.segments));
      this.db.setSegmentsHash(recording.id, hash);
      acc.updatedSegments++;
    }

    // 3. Notes written by the refiner (<id>.clean.md)
    const notesPath = path.join(dir, `${transcriptId}.clean.md`);
    let notesChanged = false;
    if (fs.existsSync(notesPath)) {
      const markdown = fs.readFileSync(notesPath, 'utf8');
      const current = this.study.getNotes(recording.id);
      if (!current || current.markdown !== markdown) {
        this.study.saveNotes(recording.id, markdown, current?.model || 'imported', current?.prompt_version || 'imported');
        acc.importedNotes++;
        notesChanged = true;
      }
    }

    // 4. Chunks: rebuilt per source, so new notes never discard transcript embeddings
    const notes = this.study.getNotes(recording.id);
    if (this.study.countChunks(recording.id) === 0) {
      this.study.replaceChunks(recording.id, 'transcript', chunkSegments(transcript.segments));
      this.study.replaceChunks(recording.id, 'notes', notes ? chunkNotes(notes.markdown) : []);
    } else if (notesChanged) {
      this.study.replaceChunks(recording.id, 'notes', notes ? chunkNotes(notes.markdown) : []);
    }

    if (recording.status !== 'processed') this.db.updateStatus(recording.collab_id, 'processed');
    return this.db.getRecordingById(recording.id)!;
  }
}
