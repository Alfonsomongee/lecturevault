import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { DashboardServer } from '../../src/dashboard/DashboardServer.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { StudyRepository } from '../../src/database/StudyRepository.js';
import { TranscriptIngestor } from '../../src/library/TranscriptIngestor.js';

const logger = pino({ level: 'silent' });

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

function request(
  port: number,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: any;
          try { json = JSON.parse(body); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Dashboard API', () => {
  let tmp: string;
  let db: DatabaseManager;
  let server: DashboardServer;
  let port: number;
  let recId: number;

  const origin = () => `http://127.0.0.1:${port}`;
  const get = (url: string, headers: Record<string, string> = {}) => request(port, 'GET', url, { headers });
  const send = (method: string, url: string, body: unknown, headers: Record<string, string> = {}) =>
    request(port, method, url, { body, headers: { Origin: origin(), ...headers } });

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-api-'));
    db = new DatabaseManager(path.join(tmp, 't.db'), logger);

    const dir = path.join(tmp, 'transcripts', 'clase1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clase1.json'), JSON.stringify({
      recordingId: 'clase1', audioDurationSeconds: 100, timestamp: '2026-03-02T10:00:00Z',
      segments: [
        { id: 0, start: 0, end: 10, text: 'Definimos las restricciones en Ansys.', no_speech_prob: 0.01 },
        { id: 1, start: 10, end: 20, text: 'La práctica de CYPE pesa un treinta por ciento.', no_speech_prob: 0.01 },
      ],
    }));
    fs.writeFileSync(path.join(dir, 'clase1.clean.md'), '# Clase\n\n## Evaluación [00:10]\n\nCYPE pesa el 30%.');
    fs.mkdirSync(path.join(tmp, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'audio', 'clase1.wav'), Buffer.alloc(1000, 7));
    fs.writeFileSync(path.join(tmp, 'secret.wav'), 'top secret');

    new TranscriptIngestor(db, tmp, logger).ingestAll({ course: 'Simulación' });
    recId = db.getRecordingByTranscriptId('clase1')!.id;
    const study = new StudyRepository(db.handle);
    study.replaceAlerts(recId, [{ kind: 'deadline', text: 'Entrega de CYPE', quote: 'q', t_ms: 10_000, due_date: '2026-03-20' }]);
    study.upsertFlashcards(recId, [{ kind: 'basic', front: '¿Peso de CYPE?', back: '30%', t_ms: 10_000 }]);

    server = new DashboardServer(db, { port: 0, dataDir: tmp }, logger);
    await server.start();
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('security', () => {
    it('sets a strict CSP and hardening headers', async () => {
      const res = await get('/api/health');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('rejects foreign Host headers (DNS rebinding)', async () => {
      const res = await get('/api/recordings', { Host: 'evil.example.com' });
      expect(res.status).toBe(403);
    });

    it('rejects cross-site writes and non-JSON writes (CSRF)', async () => {
      const foreign = await send('PATCH', `/api/recordings/${recId}`, { course: 'x' }, { Origin: 'https://evil.example.com' });
      expect(foreign.status).toBe(403);
      const form = await request(port, 'POST', '/api/ingest', {
        headers: { Origin: origin(), 'Content-Type': 'text/plain', 'Content-Length': '2' },
      });
      expect(form.status).toBe(415);
      expect(db.getRecordingById(recId)!.course).toBe('Simulación');
    });

    it('returns clean errors for malformed JSON and bad ids', async () => {
      const bad = await request(port, 'PATCH', `/api/recordings/${recId}`, {
        headers: { Origin: origin(), 'Content-Type': 'application/json' },
        raw: '{"course": ',
      });
      expect(bad.status).toBe(400);
      expect(bad.body).not.toMatch(/at .*\.js|SyntaxError/);
      expect((await get('/api/recordings/abc')).status).toBe(400);
      expect((await get('/api/recordings/999999')).status).toBe(404);
      expect((await get('/api/recordings/' + encodeURIComponent('1; DROP TABLE recordings'))).status).toBe(400);
      const res = await get('/api/nope');
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: 'No encontrado' });
    });

    it('never serves files outside data/audio, even when the transcript id is tampered in the DB', async () => {
      db.handle.prepare('UPDATE recordings SET transcript_id = ? WHERE id = ?').run('../secret', recId);
      const res = await get(`/api/recordings/${recId}/audio`);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain('top secret');
      db.handle.prepare('UPDATE recordings SET transcript_id = ? WHERE id = ?').run('clase1', recId);
    });
  });

  describe('library', () => {
    it('lists recordings with study progress, courses and stats', async () => {
      const res = await get('/api/recordings');
      expect(res.status).toBe(200);
      expect(res.json.recordings).toHaveLength(1);
      expect(res.json.recordings[0]).toMatchObject({
        course: 'Simulación', segment_count: 2, has_notes: 1, alert_count: 1, flashcard_count: 1, has_audio: true,
      });
      expect(res.json.courses).toEqual([{ course: 'Simulación', count: 1, totalSeconds: 100 }]);
      expect(res.json.stats).toMatchObject({ total: 1, processed: 1, transcribed: 1, flashcards: 1 });
      expect((await get('/api/recordings?course=Otra')).json.recordings).toHaveLength(0);
    });

    it('returns the detail with notes, alerts and flashcards', async () => {
      const { json } = await get(`/api/recordings/${recId}`);
      expect(json.notes.markdown).toContain('Evaluación [00:10]');
      expect(json.alerts[0]).toMatchObject({ kind: 'deadline', due_date: '2026-03-20' });
      expect(json.flashcards[0].front).toBe('¿Peso de CYPE?');
      expect(json.has_audio).toBe(true);
    });

    it('lets the user assign a course', async () => {
      const res = await send('PATCH', `/api/recordings/${recId}`, { course: '  Estructuras  ' });
      expect(res.json.recording.course).toBe('Estructuras');
      expect((await send('PATCH', `/api/recordings/${recId}`, {})).status).toBe(400);
      await send('PATCH', `/api/recordings/${recId}`, { course: 'Simulación' });
    });

    it('serves segments and WebVTT subtitles', async () => {
      const segs = await get(`/api/recordings/${recId}/segments`);
      expect(segs.json.segments[1]).toMatchObject({ start_ms: 10_000, doubtful: false });
      const vtt = await get(`/api/recordings/${recId}/subtitles.vtt`);
      expect(vtt.headers['content-type']).toContain('text/vtt');
      expect(vtt.body.startsWith('WEBVTT')).toBe(true);
      expect(vtt.body).toContain('00:00:10.000 --> 00:00:20.000');
    });

    it('streams audio with Range support so the player can seek', async () => {
      const full = await get(`/api/recordings/${recId}/audio`);
      expect(full.status).toBe(200);
      expect(full.headers['accept-ranges']).toBe('bytes');
      const part = await get(`/api/recordings/${recId}/audio`, { Range: 'bytes=100-199' });
      expect(part.status).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 100-199/1000');
      expect(part.body).toHaveLength(100);
    });
  });

  describe('search and study', () => {
    it('searches with accents, prefixes, typos and filters', async () => {
      const res = await get('/api/search?q=' + encodeURIComponent('restriccion'));
      expect(res.json.hits[0]).toMatchObject({ recordingId: recId, startMs: 0 });
      const typo = await get('/api/search?q=ansis');
      expect(typo.json.corrected).toEqual([{ from: 'ansis', to: 'ansys' }]);
      expect((await get('/api/search?q=')).json.hits).toEqual([]);
      expect((await get('/api/search?q=cype&course=Otra')).json.hits).toEqual([]);
      expect((await get('/api/search?q=%22%20OR%20NEAR(')).status).toBe(200);
    });

    it('answers "ask" with BM25 sources when no AI key is configured', async () => {
      const res = await send('POST', '/api/ask', { question: '¿Qué peso tiene CYPE?' });
      expect(res.status).toBe(200);
      expect(res.json.answer).toBeNull();
      expect(res.json.sources[0].recordingId).toBe(recId);
      expect((await send('POST', '/api/ask', { question: '  ' })).status).toBe(400);
    });

    it('refuses to process without a Gemini key', async () => {
      const res = await send('POST', `/api/recordings/${recId}/process`, {});
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/GEMINI_API_KEY/);
    });

    it('lists dismissed alerts so they can be restored after a reload', async () => {
      const id = (await get('/api/alerts')).json.alerts[0].id;
      await send('PATCH', `/api/alerts/${id}`, { dismissed: true });
      const after = (await get('/api/alerts')).json.alerts.find((a: any) => a.id === id);
      expect(after.dismissed).toBe(1);
      expect((await get(`/api/recordings/${recId}`)).json.alerts.some((a: any) => a.id === id && a.dismissed)).toBe(true);
      expect((await get('/api/recordings')).json.recordings[0].alert_count).toBe(0);
      await send('PATCH', `/api/alerts/${id}`, { dismissed: false });
    });

    it('rejects impossible calendar dates', async () => {
      const id = (await get('/api/alerts')).json.alerts[0].id;
      for (const bad of ['2026-02-31', '2026-13-45', '2026-1-5']) {
        expect((await send('PATCH', `/api/alerts/${id}`, { due_date: bad })).status, bad).toBe(400);
      }
      expect((await send('PATCH', `/api/recordings/${recId}`, { date: '2026-02-30' })).status).toBe(400);
    });

    it('lets the user correct the class date and filter recordings without a course', async () => {
      const ok = await send('PATCH', `/api/recordings/${recId}`, { date: '2026-03-04' });
      expect(new Date(ok.json.recording.created_at).getDate()).toBe(4);
      await send('PATCH', `/api/recordings/${recId}`, { course: '' });
      expect((await get('/api/recordings?course=__none__')).json.recordings).toHaveLength(1);
      expect((await get('/api/search?q=cype&course=__none__')).json.hits.length).toBeGreaterThan(0);
      expect((await get('/api/flashcards?course=__none__')).json.flashcards).toHaveLength(1);
      await send('PATCH', `/api/recordings/${recId}`, { course: 'Simulación' });
    });

    it('answers 429 with a useful message when the quota endpoints are hammered', async () => {
      let last: Res | undefined;
      for (let i = 0; i < 8; i++) last = await send('POST', '/api/ingest', {});
      expect(last!.status).toBe(429);
      expect(last!.json.error).toMatch(/espera/);
    });

    it('confirms alerts and validates dates', async () => {
      const alertId = (await get('/api/alerts')).json.alerts[0].id;
      const ok = await send('PATCH', `/api/alerts/${alertId}`, { confirmed: true, due_date: '2026-03-21' });
      expect(ok.json.alert).toMatchObject({ confirmed: 1, due_date: '2026-03-21' });
      expect((await send('PATCH', `/api/alerts/${alertId}`, { due_date: '21/03' })).status).toBe(400);
      expect((await send('PATCH', '/api/alerts/9999', { confirmed: true })).status).toBe(404);
    });

    it('exports a calendar with only confirmed alerts when asked', async () => {
      const all = await get('/api/calendar.ics');
      expect(all.headers['content-type']).toContain('text/calendar');
      expect(all.body).toContain('DTSTART;VALUE=DATE:20260321');
      const study = new StudyRepository(db.handle);
      study.replaceAlerts(recId, [{ kind: 'exam', text: 'Sin confirmar', t_ms: 99_000, due_date: '2026-04-01' }]);
      const only = await get('/api/calendar.ics?confirmed=1');
      expect(only.body).toContain('20260321');
      expect(only.body).not.toContain('Sin confirmar');
    });

    it('reviews flashcards and exports Anki files', async () => {
      const card = (await get('/api/flashcards')).json.flashcards[0];
      expect((await get('/api/flashcards?due=1')).json.flashcards).toHaveLength(1);
      const reviewed = await send('POST', `/api/flashcards/${card.id}/review`, { correct: true });
      expect(reviewed.json.flashcard.box).toBe(1);
      expect((await get('/api/flashcards?due=1')).json.flashcards).toHaveLength(0);
      expect((await send('POST', `/api/flashcards/${card.id}/review`, {})).status).toBe(400);

      const anki = await get('/api/export/anki?kind=basic');
      expect(anki.headers['content-disposition']).toContain('lecturevault-anki-basic.txt');
      expect(anki.body).toContain('#notetype:Basic');
      expect(anki.body).toContain('¿Peso de CYPE?');
    });

    it('re-ingests transcripts on demand', async () => {
      // (the previous test exhausted the ingest limiter on purpose; call the ingestor directly)
      const result = new TranscriptIngestor(db, tmp, logger).ingestAll();
      expect(result.scanned).toBe(1);
      expect(result.updatedSegments).toBe(0);
    });
  });

  describe('UI shell', () => {
    it('serves the app and vendored libraries from the local server', async () => {
      expect((await get('/')).status).toBe(200);
      expect((await get('/some/deep/link')).headers['content-type']).toContain('text/html');
      for (const url of ['/vendor/marked.js', '/vendor/purify.js', '/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css']) {
        expect((await get(url)).status, url).toBe(200);
      }
    });
  });
});
