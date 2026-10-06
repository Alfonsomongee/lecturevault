/**
 * StudyPipeline — turns a transcribed recording into everything the dashboard shows:
 * clean notes (.clean.md + SQLite), alerts, flashcards, glossary and searchable/embedded chunks.
 *
 * Each step is independent and failure-isolated: if flashcards fail (rate limit, bad JSON) the
 * notes are still saved, and the report says exactly what happened. Re-running only does the
 * missing work unless `force` is set.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { DatabaseManager } from '../database/DatabaseManager.js';
import { StudyRepository } from '../database/StudyRepository.js';
import { GeminiClient } from '../ai/GeminiClient.js';
import { NOTES_PROMPT_VERSION, TranscriptRefiner } from '../ai/TranscriptRefiner.js';
import { StudyGenerator } from './StudyGenerator.js';
import { Rag } from '../search/Rag.js';
import { chunkNotes } from '../library/chunker.js';
import { isSafeTranscriptId } from '../utils/ids.js';

export type PipelineStep = 'notes' | 'study' | 'embeddings';

export interface PipelineOptions {
  force?: boolean;
  steps?: PipelineStep[];
}

export interface PipelineReport {
  recordingId: number;
  notes: 'created' | 'kept' | 'skipped' | 'failed';
  alerts: number;
  flashcards: number;
  glossary: number;
  embedded: number;
  errors: string[];
}

export interface PipelineConfig {
  dataDir: string;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiEmbeddingModel?: string;
}

export class StudyPipeline {
  readonly study: StudyRepository;
  private readonly client: GeminiClient;
  private readonly logger?: Logger;

  constructor(
    private readonly db: DatabaseManager,
    private readonly config: PipelineConfig,
    logger?: Logger,
    client?: GeminiClient
  ) {
    this.logger = logger?.child({ component: 'study-pipeline' });
    this.study = new StudyRepository(db.handle);
    this.client =
      client ??
      new GeminiClient({
        apiKey: config.geminiApiKey,
        model: config.geminiModel,
        embeddingModel: config.geminiEmbeddingModel,
        logger,
      });
  }

  get hasAi(): boolean {
    return this.client.hasKey;
  }

  /** Terms learned from earlier classes of the same course (spelling + Whisper hotwords). */
  courseTerms(course: string, limit = 60): string[] {
    return this.study.courseTerms(course, limit);
  }

  async process(recordingId: number, options: PipelineOptions = {}): Promise<PipelineReport> {
    const steps = new Set<PipelineStep>(options.steps ?? ['notes', 'study', 'embeddings']);
    const report: PipelineReport = {
      recordingId, notes: 'skipped', alerts: 0, flashcards: 0, glossary: 0, embedded: 0, errors: [],
    };

    const recording = this.db.getRecordingById(recordingId);
    if (!recording) throw new Error(`No existe la grabación ${recordingId}`);

    const segments = this.study.getSegments(recordingId).map((s) => ({
      start: s.start_ms / 1000,
      end: s.end_ms / 1000,
      text: s.text,
      avg_logprob: s.avg_logprob ?? undefined,
      no_speech_prob: s.no_speech_prob ?? undefined,
    }));
    if (segments.length === 0) throw new Error('La grabación aún no tiene transcripción (ejecuta "ingest" primero).');

    if (!this.client.hasKey) {
      report.errors.push('GEMINI_API_KEY no configurada: solo se indexa el texto para búsqueda.');
      return report;
    }

    const glossary = this.courseTerms(recording.course);
    let notesChanged = false;

    // 1. Notes
    if (steps.has('notes')) {
      const existing = this.study.getNotes(recordingId);
      // Notes written before timestamps existed can't drive the player, so they count as stale.
      const stale = !existing || (existing.prompt_version !== NOTES_PROMPT_VERSION && !/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(existing.markdown));
      if (options.force || stale) {
        try {
          const refiner = new TranscriptRefiner({ client: this.client, logger: this.logger });
          const markdown = await refiner.refineSegments(segments, {
            title: recording.title, course: recording.course, glossary,
          });
          this.study.saveNotes(recordingId, markdown, this.client.model, NOTES_PROMPT_VERSION);
          this.writeNotesFile(recording.transcript_id, markdown);
          report.notes = 'created';
          notesChanged = true;
        } catch (err) {
          report.notes = 'failed';
          report.errors.push(`Apuntes: ${(err as Error).message}`);
        }
      } else {
        report.notes = 'kept';
      }
    }

    // 2. Alerts, flashcards, glossary
    if (steps.has('study')) {
      const hasStudy =
        this.study.listAlerts({ recordingId, includeDismissed: true }).length > 0 ||
        this.study.listFlashcards({ recordingId }).length > 0;
      if (options.force || !hasStudy) {
        try {
          const generator = new StudyGenerator({ client: this.client, logger: this.logger });
          const out = await generator.generate(segments, {
            title: recording.title,
            course: recording.course,
            classDate: recording.created_at,
            durationSeconds: recording.duration_seconds,
            glossary,
          });
          report.alerts = this.study.replaceAlerts(recordingId, out.alerts);
          report.flashcards = this.study.upsertFlashcards(recordingId, out.flashcards);
          report.glossary = this.study.upsertGlossary(recordingId, out.glossary);
        } catch (err) {
          report.errors.push(`Estudio: ${(err as Error).message}`);
        }
      }
    }

    // 3. Retrieval index: rebuild chunks when notes changed, then embed what is missing
    if (notesChanged) {
      const notes = this.study.getNotes(recordingId);
      this.study.replaceChunks(recordingId, 'notes', notes ? chunkNotes(notes.markdown) : []);
    }
    if (steps.has('embeddings')) {
      try {
        report.embedded = await new Rag(this.db.handle, this.client, this.logger).indexEmbeddings();
      } catch (err) {
        report.errors.push(`Embeddings: ${(err as Error).message}`);
      }
    }

    this.logger?.info({ report }, 'Procesado de estudio terminado');
    return report;
  }

  /** Process every transcribed recording that still lacks something. */
  async processPending(options: PipelineOptions = {}): Promise<PipelineReport[]> {
    const reports: PipelineReport[] = [];
    for (const row of this.study.getOverview()) {
      if (row.segment_count === 0) continue;
      const missing = !row.has_notes || (row.alert_count === 0 && row.flashcard_count === 0);
      if (!options.force && !missing) continue;
      try {
        reports.push(await this.process(row.id, options));
      } catch (err) {
        reports.push({
          recordingId: row.id, notes: 'failed', alerts: 0, flashcards: 0, glossary: 0, embedded: 0,
          errors: [(err as Error).message],
        });
      }
    }
    return reports;
  }

  /** Keep the notes file next to the transcript so data/ stays the source of truth. */
  private writeNotesFile(transcriptId: string | null, markdown: string): void {
    if (!transcriptId || !isSafeTranscriptId(transcriptId)) return;
    const dir = path.join(this.config.dataDir, 'transcripts', transcriptId);
    if (!fs.existsSync(dir)) return;
    fs.writeFileSync(path.join(dir, `${transcriptId}.clean.md`), markdown, 'utf8');
    fs.writeFileSync(path.join(dir, `${transcriptId}.clean.txt`), markdown, 'utf8');
  }
}
