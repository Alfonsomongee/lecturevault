/**
 * CLI commands for the study copilot: ingest, study, ask, search, export, optimize-audio, demo.
 * Kept out of index.ts so the capture pipeline code stays readable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import type { AppConfig } from '../types.js';
import { DatabaseManager } from '../database/DatabaseManager.js';
import { StudyRepository } from '../database/StudyRepository.js';
import { TranscriptIngestor } from '../library/TranscriptIngestor.js';
import { StudyPipeline, type PipelineReport } from '../study/StudyPipeline.js';
import { SearchIndex, MARK_CLOSE, MARK_OPEN } from '../search/SearchIndex.js';
import { Rag } from '../search/Rag.js';
import { GeminiClient } from '../ai/GeminiClient.js';
import { buildAnkiTsv, buildIcs, noteFileName, renderObsidianNote } from '../study/exporters.js';
import { convertToOpus, findPlaybackAudio } from '../library/audio.js';
import { DashboardServer } from '../dashboard/DashboardServer.js';
import { seedDemo } from '../demo/seed.js';
import { msToClock } from '../utils/time.js';
import { parseIso } from '../study/dates.js';
import { fold } from '../utils/text.js';
import { CourseCatalog, courseLabel } from '../library/courses.js';
import type { RecordingMetadata } from '../types.js';

function args(options: Record<string, { type: 'string' | 'boolean'; short?: string }>) {
  return parseArgs({ args: process.argv.slice(3), options, allowPositionals: true, strict: false });
}

function pipelineConfig(config: AppConfig) {
  return {
    dataDir: config.dataDir,
    geminiApiKey: config.geminiApiKey,
    geminiModel: config.geminiModel,
    geminiEmbeddingModel: config.geminiEmbeddingModel,
  };
}

function printReport(title: string, r: PipelineReport): void {
  const notes = { created: '✅ apuntes generados', kept: '↩️  apuntes ya existentes', skipped: '—', failed: '❌ apuntes fallidos' }[r.notes];
  console.log(`  ${title}: ${notes} · ${r.alerts} avisos · ${r.flashcards} tarjetas · ${r.glossary} términos · ${r.embedded} vectores`);
  for (const e of r.errors) console.log(`     ⚠️  ${e}`);
}

/** Resolve a typed `--course` ("03", "03MUIN", "sistemas eléctricos") to the catalog label; unknown values pass through. */
function courseArg(config: AppConfig, value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? CourseCatalog.load(config.dataDir).resolve(value) : undefined;
}

/** Fill in `course` on freshly scraped recordings when their title/URL carries a known course code. */
export function withDetectedCourses(config: AppConfig, recordings: RecordingMetadata[]): RecordingMetadata[] {
  const catalog = CourseCatalog.load(config.dataDir);
  return recordings.map((r) => ({ ...r, course: r.course || catalog.detect(`${r.title} ${r.playbackUrl}`) || '' }));
}

/** `ingest` — load data/transcripts/* into SQLite (segments, search index, notes). */
export async function runIngest(config: AppConfig, logger: Logger): Promise<void> {
  const { values } = args({ course: { type: 'string', short: 'c' } });
  const db = new DatabaseManager(config.databasePath, logger);
  try {
    const result = new TranscriptIngestor(db, config.dataDir, logger).ingestAll({ course: courseArg(config, values['course']) });
    console.log('\n📥 Importación de transcripciones');
    console.log(`  Carpetas analizadas:   ${result.scanned}`);
    console.log(`  Vinculadas a Collab2:  ${result.linked}`);
    console.log(`  Grabaciones locales:   ${result.created}`);
    console.log(`  Transcripciones nuevas/actualizadas: ${result.updatedSegments}`);
    console.log(`  Apuntes importados:    ${result.importedNotes}`);
    for (const s of result.skipped) console.log(`  ⚠️  ${s}`);
    console.log('');
  } finally {
    db.close();
  }
}

/** `study` — generate notes, alerts, flashcards, glossary and embeddings. */
export async function runStudy(config: AppConfig, logger: Logger): Promise<void> {
  const { values } = args({
    id: { type: 'string' },
    force: { type: 'boolean' },
    'notes-only': { type: 'boolean' },
    'upgrade-notes': { type: 'boolean' },
  });
  const db = new DatabaseManager(config.databasePath, logger);
  try {
    new TranscriptIngestor(db, config.dataDir, logger).ingestAll();
    const pipeline = new StudyPipeline(db, pipelineConfig(config), logger);
    if (!pipeline.hasAi) {
      console.log('\n❌ Falta GEMINI_API_KEY en .env: sin ella solo se puede buscar en las transcripciones.\n');
      return;
    }

    console.log('\n🧠 Copiloto de estudio\n');
    if (values['id']) {
      const id = parseInt(String(values['id']), 10);
      printReport(`#${id}`, await pipeline.process(id, { force: !!values['force'], steps: values['notes-only'] ? ['notes'] : undefined }));
    } else if (values['upgrade-notes']) {
      // Regenerate notes that predate timestamps so the interactive player works on old classes
      for (const row of pipeline.study.getOverview()) {
        if (row.segment_count > 0) printReport(row.title, await pipeline.process(row.id, { force: true, steps: ['notes', 'embeddings'] }));
      }
    } else {
      const reports = await pipeline.processPending({ force: !!values['force'] });
      if (reports.length === 0) console.log('  Todo está al día.');
      for (const r of reports) printReport(`#${r.recordingId}`, r);
    }
    console.log('');
  } finally {
    db.close();
  }
}

/** `search "texto"` — instant full-text search from the terminal. */
export async function runSearch(config: AppConfig, logger: Logger): Promise<void> {
  const { values, positionals } = args({ course: { type: 'string', short: 'c' } });
  const query = positionals.join(' ').trim();
  if (!query) {
    console.log('\nUso: npm run search -- "restricciones en Ansys" [--course "Simulación FEM"]\n');
    return;
  }
  const db = new DatabaseManager(config.databasePath, logger);
  try {
    const res = new SearchIndex(db.handle).search(query, { course: courseArg(config, values['course']), limit: 15 });
    console.log(`\n🔎 "${query}"${res.corrected.length ? `  (¿quisiste decir ${res.corrected.map((c) => `"${c.to}"`).join(', ')}?)` : ''}\n`);
    if (res.hits.length === 0) console.log('  Sin resultados.');
    for (const h of res.hits) {
      const snippet = h.snippet.split(MARK_OPEN).join('«').split(MARK_CLOSE).join('»');
      console.log(`  [${h.course || 'sin asignatura'}] ${h.recordingTitle} · ${msToClock(h.startMs)} ${h.source === 'notes' ? '(apuntes)' : ''}`);
      console.log(`    ${snippet}\n`);
    }
  } finally {
    db.close();
  }
}

/** `ask "pregunta"` — RAG over every class, with verified citations. */
export async function runAsk(config: AppConfig, logger: Logger): Promise<void> {
  const { values, positionals } = args({ course: { type: 'string', short: 'c' } });
  const question = positionals.join(' ').trim();
  if (!question) {
    console.log('\nUso: npm run ask -- "¿Qué peso tenía la práctica de CYPE?" [--course Estructuras]\n');
    return;
  }
  const db = new DatabaseManager(config.databasePath, logger);
  try {
    new TranscriptIngestor(db, config.dataDir, logger).ingestAll();
    const client = new GeminiClient({
      apiKey: config.geminiApiKey, model: config.geminiModel, embeddingModel: config.geminiEmbeddingModel, logger,
    });
    const rag = new Rag(db.handle, client, logger);
    if (client.hasKey) await rag.indexEmbeddings().catch((e) => console.log(`⚠️  Embeddings no disponibles: ${e.message}`));

    const res = await rag.ask(question, { course: courseArg(config, values['course']) });
    console.log(`\n❓ ${question}\n`);
    if (res.answer) console.log(`${res.answer}\n`);
    else console.log('(Sin GEMINI_API_KEY: se muestran los fragmentos más relevantes, sin respuesta redactada.)\n');

    if (res.citations.length) {
      console.log('📌 Citas verificadas');
      for (const c of res.citations) console.log(`  [${c.fragment}] ${c.recordingTitle} · ${msToClock(c.startMs)}\n      "${c.quote}"`);
    } else if (!res.answer) {
      for (const s of res.sources.slice(0, 5)) console.log(`  • ${s.recordingTitle} · ${msToClock(s.startMs)}\n      ${s.text.slice(0, 220)}…`);
    }
    console.log(`\n(modo: ${res.mode})\n`);
  } finally {
    db.close();
  }
}

function slug(text: string): string {
  return fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sin-asignatura';
}

/** `export` — Anki files, calendar and an Obsidian vault under data/exports. */
export async function runExport(config: AppConfig, logger: Logger): Promise<void> {
  const { values } = args({ course: { type: 'string', short: 'c' } });
  const only = courseArg(config, values['course']);
  const db = new DatabaseManager(config.databasePath, logger);
  try {
    const study = new StudyRepository(db.handle);
    const courses = db.getCourses().map((c) => c.course).filter((c) => !only || c === only);
    const out = path.join(config.dataDir, 'exports');
    console.log('\n📦 Exportación\n');

    for (const course of courses) {
      const dir = path.join(out, slug(course));
      fs.mkdirSync(dir, { recursive: true });
      const cards = study.listFlashcards({ course, limit: 10_000 });
      fs.writeFileSync(path.join(dir, 'anki-basic.txt'), buildAnkiTsv(cards, 'basic'));
      fs.writeFileSync(path.join(dir, 'anki-cloze.txt'), buildAnkiTsv(cards, 'cloze'));
      fs.writeFileSync(path.join(dir, 'calendario.ics'), buildIcs(study.listAlerts({ course }), { calendarName: `LectureVault · ${course || 'General'}` }));

      const vault = path.join(out, 'obsidian', slug(course));
      fs.mkdirSync(vault, { recursive: true });
      let notes = 0;
      for (const rec of db.getAllRecordings().filter((r) => r.course === course)) {
        const n = study.getNotes(rec.id);
        if (!n) continue;
        fs.writeFileSync(
          path.join(vault, `${noteFileName(rec)}.md`),
          renderObsidianNote(rec, n.markdown, study.listAlerts({ recordingId: rec.id }), study.listFlashcards({ recordingId: rec.id }))
        );
        notes++;
      }
      console.log(`  ${course || '(sin asignatura)'}: ${cards.length} tarjetas · ${notes} notas Markdown → ${dir}`);
    }
    if (courses.length === 0) console.log('  No hay nada que exportar todavía.');
    console.log('');
  } finally {
    db.close();
  }
}

/** `optimize-audio` — make small Opus copies for the in-browser player (WAV is kept). */
export async function runOptimizeAudio(config: AppConfig, logger: Logger): Promise<void> {
  const db = new DatabaseManager(config.databasePath, logger);
  try {
    console.log('\n🎧 Optimizando audio para el reproductor\n');
    let converted = 0;
    for (const rec of db.getAllRecordings()) {
      if (!rec.transcript_id) continue;
      const found = findPlaybackAudio(config.dataDir, rec.transcript_id);
      if (!found || !found.file.endsWith('.wav')) continue;
      try {
        const out = await convertToOpus(config.dataDir, rec.transcript_id);
        const mb = (n: string) => (fs.statSync(n).size / 1024 / 1024).toFixed(1);
        console.log(`  ✅ ${rec.transcript_id}: ${mb(path.join(found.dir, found.file))} MB → ${mb(out)} MB`);
        converted++;
      } catch (err) {
        console.log(`  ❌ ${rec.transcript_id}: ${(err as Error).message}`);
      }
    }
    console.log(`\n  ${converted} archivo(s) convertido(s). Los WAV originales se conservan.\n`);
  } finally {
    db.close();
  }
}

/** `demo` — seed a self-contained demo library and serve it (never touches your real data). */
export async function runDemo(config: AppConfig, logger: Logger): Promise<void> {
  const demoDir = path.join(config.dataDir, 'demo');
  const seeded = seedDemo(demoDir, logger);
  const db = new DatabaseManager(seeded.dbPath, logger);
  const dashboard = new DashboardServer(db, { port: config.dashboardPort, dataDir: seeded.dataDir }, logger);

  const shutdown = async () => {
    await dashboard.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await dashboard.start();
  console.log(`\n🎓 Demo de LectureVault: ${seeded.recordings} clases de ejemplo en ${seeded.dataDir}`);
  console.log(`   Abre http://localhost:${config.dashboardPort}  (Ctrl+C para salir)\n`);
}

/**
 * After a capture + transcription: index the new transcript and, when a Gemini key is configured,
 * generate notes/alerts/flashcards. Returns quietly on AI failure — the transcript is already safe.
 */
export async function finalizeTranscript(
  db: DatabaseManager,
  config: AppConfig,
  logger: Logger,
  transcriptId: string,
  course?: string,
  /** YYYY-MM-DD of the class; local captures only know when they were transcribed */
  classDate?: string
): Promise<PipelineReport | null> {
  let recording = new TranscriptIngestor(db, config.dataDir, logger).ingestOne(transcriptId, undefined, course);
  if (classDate && parseIso(classDate)) {
    db.setCreatedAt(recording.id, new Date(`${classDate}T10:00:00`).toISOString());
    recording = db.getRecordingById(recording.id)!;
  }
  const pipeline = new StudyPipeline(db, pipelineConfig(config), logger);
  if (!pipeline.hasAi) return null;
  return pipeline.process(recording.id);
}

export { printReport };

/**
 * `courses` — manage the subject catalog (data/courses.json).
 *   courses init   create it from courses.example.json (your 10 MUIN subjects)
 *   courses list   subjects with how many classes each has
 *   courses auto   assign unassigned classes whose title/folder contains a course code
 */
export async function runCourses(config: AppConfig, logger: Logger): Promise<void> {
  const sub = process.argv[3] ?? 'list';
  const example = path.resolve('courses.example.json');
  const catalog = () => CourseCatalog.load(config.dataDir);

  if (sub === 'init') {
    const created = CourseCatalog.init(config.dataDir, example);
    console.log(created ? `\n✅ Creado ${path.join(config.dataDir, 'courses.json')} (edítalo a mano si cambian las asignaturas)\n` : '\nℹ️  Ya existe data/courses.json; no se ha tocado.\n');
    return;
  }

  const db = new DatabaseManager(config.databasePath, logger);
  try {
    if (sub === 'auto') {
      let n = 0;
      for (const rec of db.getAllRecordings().filter((r) => !r.course)) {
        const found = catalog().detect(`${rec.title} ${rec.transcript_id ?? ''} ${rec.playback_url}`);
        if (found) { db.setCourse(rec.id, found); n++; console.log(`  ${rec.title} → ${found}`); }
      }
      console.log(`\n${n} clase(s) asignada(s). El resto se puede asignar en el dashboard (selección múltiple).\n`);
      return;
    }
    const cat = catalog();
    if (cat.courses.length === 0) {
      console.log('\nNo hay catálogo. Ejecuta: npm run courses -- init\n');
      return;
    }
    const counts = new Map(db.getCourses().map((c) => [c.course, c.count]));
    console.log('\n📚 Asignaturas\n');
    for (const c of cat.courses) console.log(`  ${courseLabel(c).padEnd(70)} ${String(counts.get(courseLabel(c)) ?? 0).padStart(3)} clases`);
    console.log(`\n  Sin asignatura: ${counts.get('') ?? 0}\n`);
  } finally {
    db.close();
  }
}
