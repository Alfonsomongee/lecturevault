import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { CourseCatalog, courseLabel } from '../../src/library/courses.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { TranscriptIngestor } from '../../src/library/TranscriptIngestor.js';

const example = JSON.parse(fs.readFileSync(path.resolve('courses.example.json'), 'utf8'));
const catalog = new CourseCatalog(example);

describe('CourseCatalog', () => {
  it('ships the 10 MUIN subjects', () => {
    expect(catalog.courses).toHaveLength(10);
    expect(catalog.labels[2]).toBe('03MUIN Sistemas eléctricos y de producción de energía');
  });

  it.each([
    ['03', '03MUIN'], ['3', '03MUIN'], ['10', '10MUIN'], ['03MUIN', '03MUIN'], ['muin 03', '03MUIN'],
    ['sistemas eléctricos', '03MUIN'], ['Sistemas Electricos y de produccion de energia', '03MUIN'],
    ['2026_10_A_51178', '03MUIN'], ['construcción', '09MUIN'], ['01MUIN Gestión de Empresas e Ingeniería de Organización', '01MUIN'],
  ])('resolves %s', (input, code) => {
    expect(catalog.find(input)?.code).toBe(code);
  });

  it('never guesses on ambiguous or unknown input', () => {
    expect(catalog.find('sistemas')).toBeUndefined(); // 3 subjects start with "Sistemas"
    expect(catalog.find('99')).toBeUndefined();
    expect(catalog.find('')).toBeUndefined();
    expect(catalog.resolve('Física cuántica')).toBe('Física cuántica'); // unknown stays as typed
  });

  it('detects a course code or LMS id inside titles and URLs, but not partial codes', () => {
    expect(catalog.detect('03MUIN_10_A_2026-27 Clase 4')).toBe(courseLabel(catalog.courses[2]!));
    expect(catalog.detect('https://x/ultra/courses/_51179_1/outline 2026_10_A_51179')).toContain('04MUIN');
    expect(catalog.detect('Clase de 103MUIN2')).toBeUndefined();
    expect(catalog.detect('Clase 1 de repaso')).toBeUndefined();
  });

  it('loads from data/courses.json, init does not overwrite, and a broken file is harmless', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-cat-'));
    expect(CourseCatalog.load(dir).courses).toHaveLength(0);
    expect(CourseCatalog.init(dir, path.resolve('courses.example.json'))).toBe(true);
    expect(CourseCatalog.load(dir).courses).toHaveLength(10);
    fs.writeFileSync(path.join(dir, 'courses.json'), '[]');
    expect(CourseCatalog.init(dir, path.resolve('courses.example.json'))).toBe(false);
    expect(CourseCatalog.load(dir).courses).toHaveLength(0);
    fs.writeFileSync(path.join(dir, 'courses.json'), '{not json');
    expect(CourseCatalog.load(dir).courses).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('course assignment on ingest', () => {
  let tmp: string;
  let db: DatabaseManager;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-cing-'));
    fs.copyFileSync('courses.example.json', path.join(tmp, 'courses.json'));
    db = new DatabaseManager(path.join(tmp, 't.db'), pino({ level: 'silent' }));
  });
  afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const folder = (id: string) => {
    const dir = path.join(tmp, 'transcripts', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ audioDurationSeconds: 5, segments: [{ start: 0, end: 5, text: 'hola' }] }));
  };

  it('resolves a short --course alias and detects codes from the folder name', () => {
    folder('clase_a'); folder('04MUIN_clase_2');
    new TranscriptIngestor(db, tmp, pino({ level: 'silent' })).ingestAll({ course: '03' });
    expect(db.getRecordingByTranscriptId('clase_a')!.course).toContain('03MUIN');
    expect(db.getRecordingByTranscriptId('04MUIN_clase_2')!.course).toContain('03MUIN'); // explicit --course wins
  });

  it('detects the code when no --course is given and never overrides an existing course', () => {
    folder('04MUIN_clase_2'); folder('sin_codigo');
    const ing = new TranscriptIngestor(db, tmp, pino({ level: 'silent' }));
    ing.ingestAll();
    expect(db.getRecordingByTranscriptId('04MUIN_clase_2')!.course).toContain('04MUIN');
    expect(db.getRecordingByTranscriptId('sin_codigo')!.course).toBe('');
    db.setCourse(db.getRecordingByTranscriptId('04MUIN_clase_2')!.id, 'Manual');
    ing.ingestAll();
    expect(db.getRecordingByTranscriptId('04MUIN_clase_2')!.course).toBe('Manual');
  });
});
