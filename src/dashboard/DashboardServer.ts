/**
 * LectureVault — Dashboard Server
 *
 * Express-based local dashboard bound to localhost only.
 * Serves the study-campus UI and a JSON API: library, notes, transcript, audio (with Range),
 * full-text search, "ask your classes", alerts + calendar, flashcards + Anki export.
 *
 * Local-only does not mean unguarded: any web page you visit can try to talk to
 * http://localhost:<port>. Every request is checked against the expected Host (DNS-rebinding)
 * and every mutating request against the expected Origin (CSRF); responses carry a strict CSP.
 */

import express from 'express';
import fs from 'node:fs';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { DatabaseManager } from '../database/DatabaseManager.js';
import { StudyRepository, type AlertKind } from '../database/StudyRepository.js';
import type { RecordingStatus } from '../types.js';
import { SearchIndex } from '../search/SearchIndex.js';
import { Rag } from '../search/Rag.js';
import { GeminiClient } from '../ai/GeminiClient.js';
import { StudyPipeline } from '../study/StudyPipeline.js';
import { TranscriptIngestor } from '../library/TranscriptIngestor.js';
import { findPlaybackAudio } from '../library/audio.js';
import { segmentsToVtt } from '../library/transcript-files.js';
import { buildAnkiTsv, buildIcs } from '../study/exporters.js';
import { parseIso } from '../study/dates.js';
import { CourseCatalog, courseLabel, COURSES_FILE } from '../library/courses.js';
import { chunkNotes } from '../library/chunker.js';
import { isSafeTranscriptId, sanitizeRecordingId } from '../utils/ids.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DashboardConfig {
  port: number;
  /** Root of data/ (audio, transcripts). Default ./data */
  dataDir?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiEmbeddingModel?: string;
}

/** Query value that selects recordings without a course (an empty string means "no filter" in URLs). */
export const NO_COURSE = '__none__';

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export class DashboardServer {
  private app: express.Application;
  private server: ReturnType<express.Application['listen']> | null = null;
  private db: DatabaseManager;
  private study: StudyRepository;
  private search: SearchIndex;
  private config: DashboardConfig;
  private logger: Logger;
  private dataDir: string;
  private client: GeminiClient;
  private processing = new Set<number>();
  private rate = new Map<string, number[]>();

  constructor(db: DatabaseManager, config: DashboardConfig, logger: Logger) {
    this.db = db;
    this.config = config;
    this.logger = logger.child({ component: 'dashboard' });
    this.dataDir = path.resolve(config.dataDir ?? './data');
    this.study = new StudyRepository(db.handle);
    this.search = new SearchIndex(db.handle);
    this.client = new GeminiClient({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      embeddingModel: config.geminiEmbeddingModel,
      logger,
    });
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  // ── Middleware ────────────────────────────────────────────────────────────

  private get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? this.config.port;
  }

  private allowedHosts(): string[] {
    const p = this.port;
    return [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`];
  }

  private setupMiddleware(): void {
    // Security headers + Host/Origin guards come first, before anything is served.
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', CSP);
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

      const host = (req.headers.host ?? '').toLowerCase();
      if (!this.allowedHosts().includes(host)) {
        res.status(403).json({ error: 'Host no permitido' });
        return;
      }

      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && !this.allowedHosts().some((h) => origin === `http://${h}`)) {
          res.status(403).json({ error: 'Origen no permitido' });
          return;
        }
        if (!req.is('application/json')) {
          res.status(415).json({ error: 'Se requiere Content-Type: application/json' });
          return;
        }
      }
      next();
    });

    this.app.use(express.json({ limit: '1mb' }));

    // Static UI + vendored libraries (no CDN: the dashboard works offline)
    const root = path.resolve(__dirname, '../..');
    this.app.use('/vendor/katex', express.static(path.join(root, 'node_modules/katex/dist'), { index: false }));
    this.app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/marked/lib/marked.umd.js')));
    this.app.get('/vendor/purify.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/dompurify/dist/purify.min.js')));
    this.app.use(express.static(path.join(root, 'public')));

    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      this.logger.debug({ method: req.method, path: req.path }, 'request');
      next();
    });
  }

  /** Tiny in-memory limiter for the endpoints that cost API quota. */
  private limit(name: string, max: number, windowMs = 60_000): RequestHandler {
    return (_req, res, next) => {
      const now = Date.now();
      const hits = (this.rate.get(name) ?? []).filter((t) => now - t < windowMs);
      if (hits.length >= max) {
        res.status(429).json({ error: 'Demasiadas peticiones; espera un momento.' });
        return;
      }
      hits.push(now);
      this.rate.set(name, hits);
      next();
    };
  }

  private wrap(handler: (req: Request, res: Response) => unknown | Promise<unknown>): RequestHandler {
    return (req, res) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((err) => {
          if (err instanceof HttpError) {
            res.status(err.status).json({ error: err.message });
            return;
          }
          this.logger.error({ err, path: req.path }, 'Request failed');
          res.status(500).json({ error: 'Internal server error' });
        });
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private parseId(raw: unknown): number {
    const text = String(raw ?? '');
    if (!/^\d{1,9}$/.test(text)) throw new HttpError(400, 'Identificador no válido');
    return parseInt(text, 10);
  }

  private optionalId(raw: unknown): number | undefined {
    return raw === undefined || raw === '' ? undefined : this.parseId(raw);
  }

  private recording(req: Request) {
    const rec = this.db.getRecordingById(this.parseId(req.params['id']));
    if (!rec) throw new HttpError(404, 'Grabación no encontrada');
    return rec;
  }

  private str(value: unknown, max = 200): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
  }

  /** Persist notes (history kept), mirror them to data/ and refresh the search chunks. */
  private saveNotes(rec: { id: number; transcript_id: string | null }, markdown: string): void {
    this.study.editNotes(rec.id, markdown);
    this.study.replaceChunks(rec.id, 'notes', chunkNotes(markdown));
    if (rec.transcript_id && isSafeTranscriptId(rec.transcript_id)) {
      const dir = path.join(this.dataDir, 'transcripts', rec.transcript_id);
      if (fs.existsSync(dir)) {
        fs.writeFileSync(path.join(dir, `${rec.transcript_id}.clean.md`), markdown, 'utf8');
        fs.writeFileSync(path.join(dir, `${rec.transcript_id}.clean.txt`), markdown, 'utf8');
      }
    }
  }

  /** The student's subject list (data/courses.json); read per request, it is tiny and editable by hand. */
  private catalogPayload() {
    const catalog = CourseCatalog.load(this.dataDir);
    return catalog.courses.map((c) => ({ code: c.code, name: c.name, teacher: c.teacher ?? '', label: courseLabel(c) }));
  }

  /** `?course=` filter: absent/blank → all courses; "__none__" → recordings without a course. */
  private course(value: unknown): string | undefined {
    const text = this.str(value, 80);
    return text === NO_COURSE ? '' : text;
  }

  private hasAudio(transcriptId: string | null): boolean {
    return findPlaybackAudio(this.dataDir, transcriptId) !== null;
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  private setupRoutes(): void {
    const api = express.Router();

    api.get('/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString(), ai: this.client.hasKey });
    });

    // Library overview (kept backwards compatible: `recordings`, `stats`, `timestamp`)
    api.get('/recordings', this.wrap((req, res) => {
      const status = req.query['status'] as RecordingStatus | undefined;
      const valid: RecordingStatus[] = ['new', 'seen', 'processed'];
      const course = this.course(req.query['course']);
      const recordings = this.study
        .getOverview({ status: status && valid.includes(status) ? status : undefined, course })
        .map((r) => ({ ...r, has_audio: this.hasAudio(r.transcript_id) }));

      res.json({
        recordings,
        stats: { ...this.db.getStats(), ...this.study.getStudyStats() },
        courses: this.db.getCourses(),
        catalog: this.catalogPayload(),
        ai: this.client.hasKey,
        timestamp: new Date().toISOString(),
      });
    }));

    api.get('/stats', this.wrap((_req, res) => {
      res.json({ ...this.db.getStats(), ...this.study.getStudyStats() });
    }));

    // Light sidebar/nav data (the SPA polls this; the full library list is only fetched by the library view)
    api.get('/meta', this.wrap((_req, res) => {
      res.json({
        stats: { ...this.db.getStats(), ...this.study.getStudyStats() },
        courses: this.db.getCourses(),
        catalog: this.catalogPayload(),
        pending: this.db.getAllRecordings().filter((r) => !r.transcript_id && !r.collab_id.startsWith('local:')).length,
        ai: this.client.hasKey,
      });
    }));

    api.get('/recordings/:id', this.wrap((req, res) => {
      const rec = this.recording(req);
      const notes = this.study.getNotes(rec.id);
      res.json({
        recording: rec,
        has_audio: this.hasAudio(rec.transcript_id),
        notes: notes ? { markdown: notes.markdown, model: notes.model, created_at: notes.created_at } : null,
        alerts: this.study.listAlerts({ recordingId: rec.id, includeDismissed: true }),
        flashcards: this.study.listFlashcards({ recordingId: rec.id }),
        glossary: this.study.listGlossaryForRecording(rec.id),
        markers: this.study.listMarkers(rec.id),
        position: Number(this.study.getSetting(`pos:${rec.id}`) ?? 0),
        versions: this.study.listNoteVersions(rec.id),
        ai: this.client.hasKey,
      });
    }));

    api.patch('/recordings/:id', this.wrap((req, res) => {
      const rec = this.recording(req);
      const course = typeof req.body?.course === 'string' ? req.body.course.trim().slice(0, 80) : undefined;
      const date = req.body?.date;
      const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : undefined;
      if (course === undefined && date === undefined && !title) throw new HttpError(400, 'Falta "course", "date" o "title"');
      if (title) this.db.setTitle(rec.id, title);
      if (course !== undefined) this.db.setCourse(rec.id, course === NO_COURSE ? '' : CourseCatalog.load(this.dataDir).resolve(course));
      if (date !== undefined) {
        // The class date anchors relative deadlines ("hasta el día 20"), so it must be a real calendar day
        if (typeof date !== 'string' || !parseIso(date)) throw new HttpError(400, 'Fecha no válida (usa AAAA-MM-DD)');
        this.db.setCreatedAt(rec.id, new Date(`${date}T10:00:00`).toISOString());
      }
      res.json({ recording: this.db.getRecordingById(rec.id) });
    }));

    // Move several classes to a course at once (typed value is resolved through the catalog: "03" → "03MUIN …")
    api.post('/recordings/assign', this.wrap((req, res) => {
      const ids: unknown = req.body?.ids;
      const course = typeof req.body?.course === 'string' ? req.body.course.trim().slice(0, 120) : undefined;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || course === undefined) {
        throw new HttpError(400, 'Indica "ids" (1-500) y "course"');
      }
      const label = course === NO_COURSE ? '' : CourseCatalog.load(this.dataDir).resolve(course);
      let updated = 0;
      for (const raw of ids) {
        const rec = this.db.getRecordingById(this.parseId(raw));
        if (rec) { this.db.setCourse(rec.id, label); updated++; }
      }
      res.json({ updated, course: label });
    }));

    api.get('/recordings/:id/segments', this.wrap((req, res) => {
      const rec = this.recording(req);
      res.json({
        segments: this.study.getSegments(rec.id).map((s) => ({
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          text: s.text,
          doubtful: (s.no_speech_prob ?? 0) > 0.6 || (s.avg_logprob ?? 0) < -1.0,
        })),
      });
    }));

    api.get('/recordings/:id/subtitles.vtt', this.wrap((req, res) => {
      const rec = this.recording(req);
      const segs = this.study.getSegments(rec.id).map((s) => ({ start: s.start_ms / 1000, end: s.end_ms / 1000, text: s.text }));
      res.type('text/vtt').send(segmentsToVtt(segs));
    }));

    // Audio: path comes from the DB and a validated id, never from the client. sendFile gives Range support.
    api.get('/recordings/:id/audio', this.wrap((req, res) => {
      const rec = this.recording(req);
      const audio = findPlaybackAudio(this.dataDir, rec.transcript_id);
      if (!audio) throw new HttpError(404, 'Esta grabación no tiene audio local');
      res.sendFile(audio.file, { root: audio.dir, acceptRanges: true, headers: { 'Cache-Control': 'private, max-age=3600' } });
    }));

    api.post('/recordings/:id/process', this.limit('process', 10), this.wrap(async (req, res) => {
      const rec = this.recording(req);
      if (!this.client.hasKey) throw new HttpError(400, 'Configura GEMINI_API_KEY en .env para generar apuntes con IA.');
      if (this.processing.has(rec.id)) throw new HttpError(409, 'Esta grabación ya se está procesando.');
      this.processing.add(rec.id);
      try {
        const pipeline = new StudyPipeline(this.db, {
          dataDir: this.dataDir,
          geminiApiKey: this.config.geminiApiKey,
          geminiModel: this.config.geminiModel,
          geminiEmbeddingModel: this.config.geminiEmbeddingModel,
        }, this.logger, this.client);
        const report = await pipeline.process(rec.id, { force: req.body?.force === true });
        res.json({ report });
      } finally {
        this.processing.delete(rec.id);
      }
    }));

    api.post('/ingest', this.limit('ingest', 6), this.wrap((_req, res) => {
      const result = new TranscriptIngestor(this.db, this.dataDir, this.logger).ingestAll();
      res.json({ result });
    }));

    // Full-text search
    api.get('/search', this.wrap((req, res) => {
      const q = this.str(req.query['q'], 200);
      if (!q) {
        res.json({ query: '', corrected: [], hits: [] });
        return;
      }
      const recordingId = this.optionalId(req.query['recording']);
      res.json(this.search.search(q, { course: this.course(req.query['course']), recordingId, limit: 60 }));
    }));

    // Ask your classes
    api.post('/ask', this.limit('ask', 20), this.wrap(async (req, res) => {
      const question = this.str(req.body?.question, 500);
      if (!question) throw new HttpError(400, 'Escribe una pregunta');
      const rag = new Rag(this.db.handle, this.client, this.logger);
      if (this.client.hasKey) await rag.indexEmbeddings().catch((err) => this.logger.warn({ err }, 'embeddings'));
      res.json(await rag.ask(question, { course: this.course(req.body?.course) }));
    }));

    // Alerts + calendar
    api.get('/alerts', this.wrap((req, res) => {
      res.json({ alerts: this.study.listAlerts({ course: this.course(req.query['course']), includeDismissed: req.query['dismissed'] !== '0' }) });
    }));

    api.patch('/alerts/:id', this.wrap((req, res) => {
      const id = this.parseId(req.params['id']);
      if (!this.study.getAlert(id)) throw new HttpError(404, 'Aviso no encontrado');
      const { confirmed, dismissed, due_date } = req.body ?? {};
      if (due_date !== undefined && due_date !== null && !parseIso(String(due_date))) {
        throw new HttpError(400, 'Fecha no válida (usa AAAA-MM-DD)');
      }
      this.study.updateAlert(id, {
        confirmed: typeof confirmed === 'boolean' ? confirmed : undefined,
        dismissed: typeof dismissed === 'boolean' ? dismissed : undefined,
        due_date: due_date === undefined ? undefined : due_date,
      });
      res.json({ alert: this.study.getAlert(id) });
    }));

    api.get('/calendar.ics', this.wrap((req, res) => {
      let alerts = this.study.listAlerts({ course: this.course(req.query['course']) });
      if (req.query['confirmed'] === '1') alerts = alerts.filter((a) => a.confirmed);
      res
        .type('text/calendar; charset=utf-8')
        .set('Content-Disposition', 'attachment; filename="lecturevault.ics"')
        .send(buildIcs(alerts));
    }));

    // Flashcards
    api.get('/flashcards', this.wrap((req, res) => {
      const recordingId = this.optionalId(req.query['recording']);
      res.json({
        flashcards: this.study.listFlashcards({
          course: this.course(req.query['course']),
          recordingId,
          dueOnly: req.query['due'] === '1',
          limit: 500,
        }),
      });
    }));

    api.post('/flashcards/:id/review', this.wrap((req, res) => {
      if (typeof req.body?.correct !== 'boolean') throw new HttpError(400, 'Falta "correct"');
      const card = this.study.reviewFlashcard(this.parseId(req.params['id']), req.body.correct);
      if (!card) throw new HttpError(404, 'Tarjeta no encontrada');
      res.json({ flashcard: card });
    }));

    api.get('/export/anki', this.wrap((req, res) => {
      const kind = req.query['kind'] === 'cloze' ? 'cloze' : 'basic';
      const recordingId = this.optionalId(req.query['recording']);
      const cards = this.study.listFlashcards({ course: this.course(req.query['course']), recordingId, limit: 5000 });
      res
        .type('text/tab-separated-values; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="lecturevault-anki-${kind}.txt"`)
        .send(buildAnkiTsv(cards, kind));
    }));


    // ── Editing: everything the student can change is stored in SQLite (and mirrored to files where it applies)
    api.delete('/recordings/:id', this.wrap((req, res) => {
      const rec = this.recording(req);
      const removeFiles = req.query['files'] === '1';
      if (removeFiles && rec.transcript_id && isSafeTranscriptId(rec.transcript_id)) {
        const id = rec.transcript_id;
        for (const file of fs.existsSync(path.join(this.dataDir, 'audio')) ? fs.readdirSync(path.join(this.dataDir, 'audio')) : []) {
          if (file === id + path.extname(file) || file === `raw-${id}.webm`) fs.rmSync(path.join(this.dataDir, 'audio', file), { force: true });
        }
        fs.rmSync(path.join(this.dataDir, 'transcripts', id), { recursive: true, force: true });
      }
      // A class listed by Collab2 keeps its row (the next sync would re-create it anyway); a purely local one goes away
      if (rec.collab_id.startsWith('local:')) { this.db.deleteRecording(rec.id); res.json({ removed: 'recording' }); }
      else { this.db.resetLocalData(rec.id); res.json({ removed: 'local-data' }); }
    }));

    api.put('/recordings/:id/notes', this.wrap((req, res) => {
      const rec = this.recording(req);
      const markdown = req.body?.markdown;
      if (typeof markdown !== 'string' || markdown.length > 300_000) throw new HttpError(400, 'Apuntes no válidos');
      this.saveNotes(rec, markdown);
      res.json({ saved: true, versions: this.study.listNoteVersions(rec.id) });
    }));

    api.post('/recordings/:id/notes/restore', this.wrap((req, res) => {
      const rec = this.recording(req);
      const version = this.study.getNoteVersion(rec.id, this.parseId(req.body?.version));
      if (!version) throw new HttpError(404, 'Versión no encontrada');
      this.saveNotes(rec, version.markdown);
      res.json({ markdown: version.markdown, versions: this.study.listNoteVersions(rec.id) });
    }));

    api.get('/recordings/:id/notes/versions/:version', this.wrap((req, res) => {
      const rec = this.recording(req);
      const version = this.study.getNoteVersion(rec.id, this.parseId(req.params['version']));
      if (!version) throw new HttpError(404, 'Versión no encontrada');
      res.json(version);
    }));

    api.put('/recordings/:id/position', this.wrap((req, res) => {
      const rec = this.recording(req);
      const t = Number(req.body?.t);
      if (!Number.isFinite(t) || t < 0 || t > 86_400) throw new HttpError(400, 'Posición no válida');
      this.study.setSetting(`pos:${rec.id}`, String(Math.floor(t)));
      res.json({ saved: true });
    }));

    api.post('/recordings/:id/markers', this.wrap((req, res) => {
      const rec = this.recording(req);
      const text = this.str(req.body?.text, 500);
      const t = Number(req.body?.t_ms);
      if (!text || !Number.isFinite(t) || t < 0) throw new HttpError(400, 'Marcador no válido');
      this.study.addMarker(rec.id, Math.round(t), text);
      res.json({ markers: this.study.listMarkers(rec.id) });
    }));

    api.delete('/recordings/:id/markers/:marker', this.wrap((req, res) => {
      const rec = this.recording(req);
      if (!this.study.deleteMarker(rec.id, this.parseId(req.params['marker']))) throw new HttpError(404, 'Marcador no encontrado');
      res.json({ markers: this.study.listMarkers(rec.id) });
    }));

    api.post('/recordings/:id/alerts', this.wrap((req, res) => {
      const rec = this.recording(req);
      const kind = String(req.body?.kind);
      const text = this.str(req.body?.text, 400);
      const due = req.body?.due_date ? String(req.body.due_date) : null;
      if (!['exam', 'deadline', 'grading', 'warning', 'formula'].includes(kind) || !text) throw new HttpError(400, 'Aviso no válido');
      if (due && !parseIso(due)) throw new HttpError(400, 'Fecha no válida (usa AAAA-MM-DD)');
      const t = Number.isFinite(Number(req.body?.t_ms)) ? Math.max(0, Math.round(Number(req.body.t_ms))) : 0;
      res.json({ alert: this.study.createAlert(rec.id, { kind: kind as AlertKind, text, t_ms: t, due_date: due }) });
    }));

    api.delete('/alerts/:id', this.wrap((req, res) => {
      if (!this.study.deleteAlert(this.parseId(req.params['id']))) throw new HttpError(400, 'Solo se pueden borrar avisos creados a mano (los demás se descartan)');
      res.json({ deleted: true });
    }));

    const cardInput = (body: any, partial = false) => {
      const kind: 'basic' | 'cloze' | undefined = body?.kind === 'cloze' ? 'cloze' : body?.kind === 'basic' ? 'basic' : partial ? undefined : 'basic';
      const front = this.str(body?.front, 2000);
      const back = typeof body?.back === 'string' ? body.back.trim().slice(0, 2000) : partial ? undefined : '';
      const tag = typeof body?.tag === 'string' ? body.tag.trim().replace(/\s+/g, '_').slice(0, 40) : undefined;
      if (!partial && !front) throw new HttpError(400, 'La tarjeta necesita anverso');
      const effectiveKind = kind;
      if (front && effectiveKind === 'cloze' && !/\{\{c\d+::.+?\}\}/.test(front)) throw new HttpError(400, 'Una tarjeta cloze necesita un hueco {{c1::respuesta}}');
      if (!partial && effectiveKind === 'basic' && !back) throw new HttpError(400, 'La tarjeta necesita reverso');
      return { kind: effectiveKind, front, back, tag };
    };

    api.post('/recordings/:id/flashcards', this.wrap((req, res) => {
      const rec = this.recording(req);
      const c = cardInput(req.body);
      const card = this.study.createFlashcard(rec.id, { kind: c.kind as 'basic' | 'cloze', front: c.front!, back: c.back ?? '', tag: c.tag, t_ms: Math.max(0, Math.round(Number(req.body?.t_ms) || 0)) });
      if (!card) throw new HttpError(409, 'Ya existe una tarjeta con ese anverso en esta clase');
      res.json({ flashcard: card });
    }));

    api.patch('/flashcards/:id', this.wrap((req, res) => {
      const id = this.parseId(req.params['id']);
      const existing = this.study.getFlashcard(id);
      if (!existing) throw new HttpError(404, 'Tarjeta no encontrada');
      const c = cardInput(req.body, true);
      const merged = { kind: c.kind ?? existing.kind, front: c.front ?? existing.front };
      if (merged.kind === 'cloze' && !/\{\{c\d+::.+?\}\}/.test(merged.front)) throw new HttpError(400, 'Una tarjeta cloze necesita un hueco {{c1::respuesta}}');
      res.json({ flashcard: this.study.updateFlashcard(id, { kind: c.kind, front: c.front, back: c.back, tag: c.tag }) });
    }));

    api.delete('/flashcards/:id', this.wrap((req, res) => {
      if (!this.study.deleteFlashcard(this.parseId(req.params['id']))) throw new HttpError(404, 'Tarjeta no encontrada');
      res.json({ deleted: true });
    }));

    // ── Pending: Collab2 classes with no local capture yet, with the exact command to run
    api.get('/pending', this.wrap((_req, res) => {
      const catalog = CourseCatalog.load(this.dataDir);
      const pending = this.db.getAllRecordings().filter((r) => !r.transcript_id && !r.collab_id.startsWith('local:'));
      const d = (iso: string) => { const x = new Date(iso); return Number.isNaN(x.getTime()) ? '' : `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
      res.json({
        pending: pending.map((r) => {
          const found = r.course ? catalog.find(r.course) : undefined;
          const parts = ['npm run capture:and:transcribe --'];
          if (found) parts.push(`--course ${found.code}`);
          else if (r.course) parts.push(`--course "${r.course.replace(/"/g, '')}"`);
          if (d(r.created_at)) parts.push(`--date ${d(r.created_at)}`);
          parts.push(`--name ${sanitizeRecordingId(r.collab_id)}`);
          return { id: r.id, title: r.title, course: r.course, created_at: r.created_at, duration_seconds: r.duration_seconds, command: parts.join(' ') };
        }),
        batch: 'npm run batch:transcribe -- --speed 4 --silent',
      });
    }));

    // ── Settings, catalog, backup
    const SETTING_KEYS = new Set(['theme', 'course']);
    api.get('/settings', this.wrap((_req, res) => {
      res.json({ settings: Object.fromEntries(Object.entries(this.study.getSettings()).filter(([k]) => SETTING_KEYS.has(k))) });
    }));

    api.put('/settings', this.wrap((req, res) => {
      for (const [key, value] of Object.entries(req.body ?? {})) {
        if (!SETTING_KEYS.has(key) || typeof value !== 'string' || value.length > 200) throw new HttpError(400, `Ajuste no válido: ${key}`);
        if (key === 'theme' && !['light', 'dark', 'system'].includes(value)) throw new HttpError(400, 'Tema no válido');
        this.study.setSetting(key, value);
      }
      res.json({ saved: true });
    }));

    api.get('/system', this.wrap((_req, res) => {
      const dbPath = this.db.handle.name;
      const dir = path.join(this.dataDir, 'backups');
      res.json({
        ai: this.client.hasKey,
        model: this.client.model,
        dataDir: this.dataDir,
        dbPath,
        dbBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
        backups: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().slice(0, 10) : [],
        stats: { ...this.db.getStats(), ...this.study.getStudyStats() },
      });
    }));

    api.post('/backup', this.limit('backup', 6), this.wrap(async (_req, res) => {
      const dir = path.join(this.dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
      const file = path.join(dir, `lecturevault-${stamp}.db`);
      await this.db.handle.backup(file); // consistent online copy, safe while the server runs
      const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
      for (const old of all.slice(0, Math.max(0, all.length - 10))) fs.rmSync(path.join(dir, old), { force: true });
      res.json({ file, bytes: fs.statSync(file).size });
    }));

    api.get('/catalog', this.wrap((_req, res) => {
      res.json({ courses: CourseCatalog.load(this.dataDir).courses });
    }));

    api.put('/catalog', this.wrap((req, res) => {
      const list: unknown = req.body?.courses;
      if (!Array.isArray(list) || list.length > 60) throw new HttpError(400, 'Catálogo no válido');
      const clean = list.map((c: any) => ({
        code: String(c?.code ?? '').trim().slice(0, 30),
        name: String(c?.name ?? '').trim().slice(0, 160),
        ...(c?.teacher ? { teacher: String(c.teacher).trim().slice(0, 120) } : {}),
        ...(c?.lmsId ? { lmsId: String(c.lmsId).trim().slice(0, 60) } : {}),
      }));
      if (clean.some((c) => !c.code || !c.name)) throw new HttpError(400, 'Cada asignatura necesita código y nombre');
      if (new Set(clean.map((c) => c.code.toLowerCase())).size !== clean.length) throw new HttpError(400, 'Hay códigos repetidos');
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, COURSES_FILE), JSON.stringify(clean, null, 2));
      res.json({ courses: clean });
    }));

    api.use((_req, res) => {
      res.status(404).json({ error: 'No encontrado' });
    });

    this.app.use('/api', api);

    // Serve index.html for all other routes (SPA fallback)
    this.app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, '../../public/index.html'));
    });

    // Last-resort handler: malformed JSON etc. must not leak stack traces
    this.app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
      if (status === 500) this.logger.error({ err }, 'Unhandled error');
      res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Petición no válida' });
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Start the dashboard server, bound to localhost only */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, '127.0.0.1', () => {
          this.logger.info({ port: this.port }, `Dashboard running at http://localhost:${this.port}`);
          resolve();
        });

        this.server.on('error', (err) => {
          this.logger.error({ err }, 'Dashboard server error');
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Port actually bound (useful when configured with port 0 in tests) */
  getPort(): number {
    return this.port;
  }

  /** Stop the dashboard server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Dashboard server stopped');
          resolve();
        });
        this.server.closeAllConnections?.();
      } else {
        resolve();
      }
    });
  }

  /** Get the Express app instance (for testing) */
  getApp(): express.Application {
    return this.app;
  }
}
