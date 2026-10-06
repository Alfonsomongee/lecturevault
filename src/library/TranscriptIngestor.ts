/**
 * Ingests files from data/transcripts/<id>/ into SQLite (segments, FTS, notes, RAG chunks)
 * and links each transcript folder to its recording.
 *
 * Idempotent: re-running only touches what changed, so embeddings (which cost API calls)
 * are not thrown away unless the transcript itself changed.
 */

import fs from 'node:fs';
import path from 'node:path';
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

    for (const entry of fs.readdirSync(this.transcriptsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        this.ingestOne(entry.name, result, options.course);
      } catch (err) {
        result.skipped.push(`${entry.name}: ${(err as Error).message}`);
        this.logger?.warn({ err, id: entry.name }, 'No se pudo ingerir la transcripción');
      }
    }
    return result;
  }

  /** Ingest one transcript folder by id. Returns the recording it belongs to. */
  ingestOne(transcriptId: string, result?: IngestResult, course?: string): RecordingRow {
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
      const match = this.db
        .getAllRecordings()
        .find(
          (r) =>
            !r.transcript_id &&
            (sanitizeRecordingId(r.collab_id) === transcriptId || sanitizeRecordingId(r.title) === transcriptId)
        );
      if (match) {
        this.db.setTranscriptId(match.id, transcriptId);
        recording = this.db.getRecordingById(match.id)!;
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

    // 2. Segments (+ transcript chunks) only when the transcript changed
    const existing = this.study.getSegments(recording.id);
    const lastExisting = existing[existing.length - 1];
    const lastNew = transcript.segments[transcript.segments.length - 1];
    const unchanged =
      existing.length === transcript.segments.length &&
      (existing.length === 0 || Math.round(lastNew!.end * 1000) === lastExisting!.end_ms);

    if (!unchanged) {
      this.study.replaceSegments(recording.id, transcript.segments);
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

    // 4. Rebuild chunks when either source changed (embeddings are recomputed lazily)
    if (!unchanged || notesChanged || this.study.getChunks({ recordingId: recording.id }).length === 0) {
      const chunks = [...chunkSegments(transcript.segments)];
      const notes = this.study.getNotes(recording.id);
      if (notes) chunks.push(...chunkNotes(notes.markdown));
      this.study.replaceChunks(recording.id, chunks);
    }

    if (recording.status !== 'processed') this.db.updateStatus(recording.collab_id, 'processed');
    return this.db.getRecordingById(recording.id)!;
  }
}
