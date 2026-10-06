import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiClient, GeminiError } from '../../src/ai/GeminiClient.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { StudyRepository, type AlertRow, type FlashcardRow } from '../../src/database/StudyRepository.js';
import { TranscriptIngestor } from '../../src/library/TranscriptIngestor.js';
import type { TranscriptSegment } from '../../src/library/transcript-files.js';
import { resolveDateText, sanitizeDueDate, parseIso, isValidDate } from '../../src/study/dates.js';
import { locateEvidence } from '../../src/study/grounding.js';
import { validateStudyOutput, StudyGenerator, type StudyContext } from '../../src/study/StudyGenerator.js';
import { buildAnkiTsv, buildIcs, foldIcsLine, noteFileName, renderObsidianNote } from '../../src/study/exporters.js';
import { Rag, queryTokens } from '../../src/search/Rag.js';

const logger = pino({ level: 'silent' });
const KEY = 'AIza-test-secret-key';

function geminiText(text: string, finishReason = 'STOP') {
  return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] }) };
}

afterEach(() => vi.unstubAllGlobals());

describe('GeminiClient', () => {
  const client = (extra = {}) => new GeminiClient({ apiKey: KEY, backoffMs: 0, logger, ...extra });

  it('sends the key in a header, never in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiText('hola'));
    vi.stubGlobal('fetch', fetchMock);
    await client().generateText('x');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain(KEY);
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': KEY });
  });

  it('retries 503 then succeeds, but not 400', async () => {
    const fail = { ok: false, status: 503, statusText: 'Unavailable', text: async () => 'busy' };
    const fetchMock = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(fail).mockResolvedValueOnce(geminiText('ok'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await client().generateText('x')).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const bad = { ok: false, status: 400, statusText: 'Bad', text: async () => 'nope' };
    const fetch400 = vi.fn().mockResolvedValue(bad);
    vi.stubGlobal('fetch', fetch400);
    await expect(client().generateText('x')).rejects.toThrow(/400/);
    expect(fetch400).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts without leaking the key', async () => {
    const fail = { ok: false, status: 429, statusText: 'Too Many', text: async () => 'quota' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail));
    const err = await client({ maxAttempts: 2 }).generateText('x').catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.message).not.toContain(KEY);
  });

  it('refuses truncated output and skips thought parts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiText('cortado', 'MAX_TOKENS')));
    await expect(client().generateText('x')).rejects.toThrow(/MAX_TOKENS/);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'pensando', thought: true }, { text: 'respuesta' }] } }] }),
    }));
    expect(await client().generateText('x')).toBe('respuesta');
  });

  it('parses JSON, tolerating a markdown fence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiText('```json\n{"a":1}\n```')));
    expect(await client().generateJson<{ a: number }>('x', {})).toEqual({ a: 1 });
  });

  it('normalises embeddings and batches requests', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return { ok: true, json: async () => ({ embeddings: body.requests.map(() => ({ values: [3, 4] })) }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await client().embed(Array.from({ length: 120 }, (_, i) => `t${i}`), 'RETRIEVAL_DOCUMENT', 2);
    expect(out).toHaveLength(120);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out[0]![0]).toBeCloseTo(0.6);
    expect(out[0]![1]).toBeCloseTo(0.8);
  });
});

describe('Spanish date resolution', () => {
  const monday = { y: 2026, m: 3, d: 2 };

  it.each([
    ['hasta el día 20', '2026-03-20', 'medium'],
    ['el 3 de abril', '2026-04-03', 'high'],
    ['el 15 de enero', '2027-01-15', 'high'],
    ['el 28 de febrero', '2026-02-28', 'high'], // a few days back: the teacher is recapping
    ['el 1 de marzo', '2026-03-01', 'high'],
    ['el 15 de enero de 2028', '2028-01-15', 'high'],
    ['para el viernes', '2026-03-06', 'medium'],
    ['el lunes', '2026-03-09', 'medium'],
    ['mañana', '2026-03-03', 'high'],
    ['pasado mañana', '2026-03-04', 'high'],
  ])('%s → %s', (text, date, confidence) => {
    expect(resolveDateText(text, monday)).toEqual({ date, confidence });
  });

  it('refuses ambiguous phrases and impossible dates', () => {
    expect(resolveDateText('la semana que viene', monday)).toBeNull();
    expect(resolveDateText('el 31 de febrero', monday)).toBeNull();
  });

  it('rolls a day-of-month into the next month that has it', () => {
    expect(resolveDateText('el día 31', { y: 2026, m: 2, d: 10 })).toEqual({ date: '2026-03-31', confidence: 'medium' });
    expect(resolveDateText('el día 5', { y: 2026, m: 12, d: 20 })).toEqual({ date: '2027-01-05', confidence: 'medium' });
  });

  it('only accepts real ISO dates close to the class', () => {
    expect(sanitizeDueDate('2026-03-20', monday)).toBe('2026-03-20');
    expect(sanitizeDueDate('2026-02-30', monday)).toBeNull();
    expect(sanitizeDueDate('2019-03-20', monday)).toBeNull();
    expect(sanitizeDueDate('20/03/2026', monday)).toBeNull();
    expect(sanitizeDueDate(null, monday)).toBeNull();
    expect(parseIso('2026-13-01')).toBeNull();
    expect(isValidDate({ y: 2028, m: 2, d: 29 })).toBe(true);
  });
});

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 8, text: 'Buenas tardes a todos, vamos a empezar la sesión.' },
  { start: 8, end: 20, text: 'Hoy definimos las restricciones en Ansys antes de lanzar el mallado.' },
  { start: 860, end: 872, text: 'Esto entra en el examen: el cálculo del momento flector en vigas.' },
  { start: 872, end: 884, text: 'La entrega de la práctica de CYPE es hasta el día 20 en el foro.' },
  { start: 884, end: 896, text: 'Cuidado con esta fórmula, el signo del momento cambia en voladizos.' },
];

const CTX: StudyContext = {
  title: 'Clase 3 Ansys', course: 'Simulación', classDate: '2026-03-02T10:00:00', durationSeconds: 900,
};

describe('grounding and validation', () => {
  it('snaps the time to where the evidence was said', () => {
    const loc = locateEvidence('entra en el examen el cálculo del momento flector', SEGMENTS, 5000);
    expect(loc.startMs).toBe(860_000);
    expect(loc.score).toBeGreaterThan(0.8);
    expect(locateEvidence('la termodinámica de los agujeros negros', SEGMENTS).score).toBe(0);
  });

  it('drops ungrounded cards and alerts, keeps and corrects grounded ones', () => {
    const out = validateStudyOutput(
      {
        alerts: [
          { kind: 'exam', text: 'Entra el momento flector en el examen', evidence: 'entra en el examen: el cálculo del momento flector', t: '99:99', confidence: 'high' },
          { kind: 'deadline', text: 'Entrega de CYPE', evidence: 'entrega de la práctica de CYPE es hasta el día 20', t: '14:32', date_text: 'hasta el día 20', due_date: '2019-01-01', confidence: 'high' },
          { kind: 'exam', text: 'Inventado', evidence: 'el profesor habló de la relatividad general y de agujeros negros', t: '03:00' },
          { kind: 'nonsense' as any, text: 'x', evidence: 'x', t: '00:00' },
        ],
        flashcards: [
          { kind: 'basic', front: '¿Qué se define antes del mallado en Ansys?', back: 'Las restricciones', tag: 'mallado fem', evidence: 'definimos las restricciones en Ansys antes de lanzar el mallado', t: '00:10' },
          { kind: 'basic', front: '¿Qué se define antes del mallado en Ansys?', back: 'duplicada', evidence: 'definimos las restricciones en Ansys antes de lanzar el mallado', t: '00:10' },
          { kind: 'basic', front: '¿Capital de Francia?', back: 'París', evidence: 'París es la capital de Francia y está en Europa', t: '01:00' },
          { kind: 'cloze', front: 'Sin hueco válido', back: '', evidence: 'restricciones en Ansys mallado', t: '00:10' },
          { kind: 'cloze', front: 'El signo del momento cambia en {{c1::voladizos}}', back: '', evidence: 'el signo del momento cambia en voladizos', t: '14:44' },
        ],
        glossary: [{ term: 'Ansys', definition: 'Software de elementos finitos', t: '00:10' }, { term: 'ANSYS', definition: 'dup' }, { term: '', definition: 'x' }],
      },
      SEGMENTS,
      CTX
    );

    expect(out.alerts.map((a) => a.kind).sort()).toEqual(['deadline', 'exam', 'warning']);
    const exam = out.alerts.find((a) => a.kind === 'exam')!;
    expect(exam.t_ms).toBe(860_000); // the bogus 99:99 was corrected from the evidence
    const deadline = out.alerts.find((a) => a.kind === 'deadline')!;
    expect(deadline.due_date).toBe('2026-03-20'); // model's 2019 date rejected, phrase resolved
    expect(out.dropped.alerts).toBe(2);

    expect(out.flashcards).toHaveLength(2);
    expect(out.flashcards[0]!.tag).toBe('mallado_fem');
    expect(out.flashcards[1]!.t_ms).toBe(884_000);
    expect(out.dropped.flashcards).toBe(3);
    expect(out.glossary).toHaveLength(1);
  });

  it('adds low-confidence safety-net alerts for key phrases the model missed', () => {
    const out = validateStudyOutput({ alerts: [], flashcards: [], glossary: [] }, SEGMENTS, CTX);
    const kinds = out.alerts.map((a) => `${a.kind}:${a.confidence}`);
    expect(kinds).toContain('exam:low');
    expect(out.alerts.some((a) => a.kind === 'deadline' && a.due_date === '2026-03-20')).toBe(true);
  });

  it('StudyGenerator anchors relative dates with the class date and weekday', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiText(JSON.stringify({ alerts: [], flashcards: [], glossary: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const gen = new StudyGenerator({ client: new GeminiClient({ apiKey: KEY, backoffMs: 0 }), logger });
    const out = await gen.generate(SEGMENTS, CTX);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.contents[0].parts[0].text).toContain('2026-03-02 (lunes)');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(out.alerts.length).toBeGreaterThan(0); // safety net
    await expect(gen.generate([], CTX)).rejects.toThrow(/vacía/);
  });
});

describe('exporters', () => {
  const card = (over: Partial<FlashcardRow>): FlashcardRow => ({
    id: 1, recording_id: 1, kind: 'basic', front: 'Q', back: 'A', tag: 'tema', t_ms: 860_000, guid: 'abc123',
    box: 0, reps: 0, due_at: '', recording_title: 'Clase 3', course: 'Simulación: FEM', ...over,
  });

  it('builds an Anki import file with headers, guid, deck, tags and neutralised fields', () => {
    const tsv = buildAnkiTsv(
      [card({}), card({ id: 2, guid: 'def', front: 'Dice "hola"\ty <b>', back: 'línea1\nlínea2' }), card({ id: 3, kind: 'cloze', front: 'El {{c1::mallado}}', back: '' })],
      'basic'
    );
    const lines = tsv.trim().split('\n');
    expect(lines.slice(0, 6)).toEqual([
      '#separator:tab', '#html:true', '#notetype:Basic', '#guid column:1', '#deck column:2', '#tags column:5',
    ]);
    expect(lines).toHaveLength(8); // cloze card excluded
    expect(lines[6]!.split('\t')).toEqual([
      'abc123', 'LectureVault::Simulación FEM', 'Q', 'A<br><br><small>🎧 Clase 3 · 14:20</small>', 'lecturevault Simulación_FEM tema',
    ]);
    expect(lines[7]).toContain('"Dice ""hola"" y &lt;b&gt;"');
    expect(lines[7]).toContain('línea1<br>línea2');
    expect(buildAnkiTsv([card({ kind: 'cloze', front: 'El {{c1::mallado}}', back: '' })], 'cloze')).toContain('#notetype:Cloze');
  });

  const alert = (over: Partial<AlertRow>): AlertRow => ({
    id: 7, recording_id: 1, kind: 'deadline', text: 'Entrega CYPE; foro, día 20', quote: 'hasta el día 20', t_ms: 872_000,
    due_date: '2026-03-31', date_text: 'día 31', confidence: 'high', confirmed: 1, dismissed: 0, created_at: '',
    recording_title: 'Clase 3', course: 'Simulación', recording_date: '2026-03-02', ...over,
  });

  it('builds valid iCalendar: CRLF, escaping, all-day with month rollover, stable UID, alarms', () => {
    const ics = buildIcs(
      [alert({}), alert({ id: 8, due_date: null }), alert({ id: 9, dismissed: 1 }), alert({ id: 10, kind: 'warning', confirmed: 0, due_date: '2026-12-31' })],
      { now: new Date('2026-03-02T10:00:00Z') }
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('UID:alert-7@lecturevault.local');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260331');
    expect(ics).toContain('DTEND;VALUE=DATE:20260401');
    expect(ics).toContain('DTEND;VALUE=DATE:20270101');
    expect(ics).toContain('DTSTAMP:20260302T100000Z');
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics).toContain('TRIGGER:-P7D');
    expect(ics).toContain('Entrega CYPE\\; foro\\, día 20');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it('folds long lines on octet boundaries without splitting characters', () => {
    const folded = foldIcsLine('SUMMARY:' + 'ñ'.repeat(120));
    const parts = folded.split('\r\n ');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe('SUMMARY:' + 'ñ'.repeat(120));
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('renders Obsidian notes with safe file names and frontmatter', () => {
    const rec = { id: 1, title: 'Clase: 3 / "FEM"?', created_at: '2026-03-02T10:00:00Z', course: 'Sim "A"', duration_seconds: 3600 } as any;
    expect(noteFileName(rec)).toBe('2026-03-02 Clase 3 FEM');
    const md = renderObsidianNote(rec, '# Notas', [alert({})], [card({ kind: 'cloze', front: 'El {{c1::mallado}}' })]);
    expect(md).toContain('course: "Sim \\"A\\""');
    expect(md).toContain('duration_min: 60');
    expect(md).toContain('==mallado==');
    expect(md).toContain('**2026-03-31**');
  });
});

describe('RAG', () => {
  let tmp: string;
  let db: DatabaseManager;

  /** Fake embedding space: one dimension per topic keyword. */
  const TOPICS = ['cype', 'ansys', 'examen', 'foro'];
  const embed = (text: string) => {
    const v = new Array(768).fill(0);
    TOPICS.forEach((t, i) => { if (text.toLowerCase().includes(t)) v[i] = 1; });
    if (v.every((x) => x === 0)) v[767] = 1;
    return v;
  };

  function mockGemini(answer: object) {
    return vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (String(url).includes('batchEmbedContents')) {
        return { ok: true, json: async () => ({ embeddings: body.requests.map((r: any) => ({ values: embed(r.content.parts[0].text) })) }) };
      }
      return geminiText(JSON.stringify(answer));
    });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-rag-'));
    db = new DatabaseManager(path.join(tmp, 't.db'), logger);
    for (const [id, text, course] of [
      ['clase_cype', 'La práctica de CYPE tiene un peso del treinta por ciento y hay que usar la suite de estructuras.', 'Estructuras'],
      ['clase_ansys', 'Para definir las restricciones en Ansys se selecciona la cara y se aplica el soporte fijo.', 'Simulación'],
      ['clase_varios', 'El foro de dudas cierra el viernes y el examen final será tipo test.', 'Simulación'],
    ] as const) {
      const dir = path.join(tmp, 'transcripts', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
        recordingId: id, audioDurationSeconds: 120, segments: [{ id: 0, start: 65, end: 80, text }],
      }));
    }
    new TranscriptIngestor(db, tmp, logger).ingestAll();
    for (const [id, course] of [['clase_cype', 'Estructuras'], ['clase_ansys', 'Simulación'], ['clase_varios', 'Simulación']] as const) {
      db.setCourse(db.getRecordingByTranscriptId(id)!.id, course);
    }
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('extracts content words from a question', () => {
    expect(queryTokens('¿En qué clase explicó el profesor cómo definir las restricciones en Ansys?')).toEqual(
      expect.arrayContaining(['definir', 'restricciones', 'ansys'])
    );
    expect(queryTokens('¿Qué peso tenía la práctica de CYPE?')).toContain('cype');
  });

  it('works without any API key: lexical sources, no generated answer', async () => {
    const rag = new Rag(db.handle, new GeminiClient({ apiKey: '' }), logger);
    const res = await rag.ask('¿Qué peso tenía la práctica de CYPE?');
    expect(res.mode).toBe('lexical');
    expect(res.answer).toBeNull();
    expect(res.sources[0]!.recordingTitle).toContain('clase cype');
    expect(res.sources[0]!.startMs).toBe(65_000);
  });

  it('answers with verified citations and a clickable time', async () => {
    const answer = {
      found: true,
      answer: 'La práctica de CYPE pesa el 30 % [F1].',
      citations: [{ fragment: 'F1', quote: 'peso del treinta por ciento' }],
    };
    vi.stubGlobal('fetch', mockGemini(answer));
    const rag = new Rag(db.handle, new GeminiClient({ apiKey: KEY, backoffMs: 0 }), logger);
    expect(await rag.indexEmbeddings()).toBe(3);
    expect(await rag.indexEmbeddings()).toBe(0);

    const res = await rag.ask('¿Qué peso tenía la práctica de CYPE?');
    expect(res.mode).toBe('hybrid');
    expect(res.found).toBe(true);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0]).toMatchObject({ startMs: 65_000 });
    expect(res.citations[0]!.recordingTitle).toContain('cype');
  });

  it('rejects hallucinated quotes instead of presenting them as grounded', async () => {
    vi.stubGlobal('fetch', mockGemini({
      found: true,
      answer: 'Pesa el 50 % [F1].',
      citations: [{ fragment: 'F1', quote: 'pesa el cincuenta por ciento' }, { fragment: 'F9', quote: 'x' }],
    }));
    const rag = new Rag(db.handle, new GeminiClient({ apiKey: KEY, backoffMs: 0 }), logger);
    const res = await rag.ask('peso de CYPE');
    expect(res.found).toBe(false);
    expect(res.citations).toHaveLength(0);
    expect(res.answer).toMatch(/No he podido verificar/);
  });

  it('semantic search finds a chunk with no shared words', async () => {
    vi.stubGlobal('fetch', mockGemini({ found: false, answer: '', citations: [] }));
    const rag = new Rag(db.handle, new GeminiClient({ apiKey: KEY, backoffMs: 0 }), logger);
    await rag.indexEmbeddings();
    // "ansys" is only in the question's embedding space; lexical gets a different word
    const { chunks } = await rag.retrieve('programa de simulación ansys fijo', { k: 1 });
    expect(chunks[0]!.recordingTitle).toContain('ansys');
  });

  it('respects the course filter', async () => {
    const rag = new Rag(db.handle, new GeminiClient({ apiKey: '' }), logger);
    const res = await rag.ask('CYPE práctica', { course: 'Simulación' });
    expect(res.sources.every((s) => s.course === 'Simulación')).toBe(true);
    expect(new StudyRepository(db.handle).getChunks({ course: 'Estructuras' })).toHaveLength(1);
  });

  it('degrades to BM25 when the embedding service fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, statusText: 'x', text: async () => 'bad' }));
    const rag = new Rag(db.handle, new GeminiClient({ apiKey: KEY, backoffMs: 0 }), logger);
    db.handle.prepare("UPDATE chunks SET embedding = zeroblob(4), embedding_model = 'x'").run();
    const { chunks, mode } = await rag.retrieve('CYPE');
    expect(mode).toBe('lexical');
    expect(chunks.length).toBeGreaterThan(0);
  });
});
