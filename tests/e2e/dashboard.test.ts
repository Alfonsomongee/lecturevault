import { test, expect } from '@playwright/test';
import { DashboardServer } from '../../src/dashboard/DashboardServer.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { StudyRepository } from '../../src/database/StudyRepository.js';
import { seedDemo } from '../../src/demo/seed.js';
import pino from 'pino';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const logger = pino({ level: 'silent' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-e2e-'));

interface Fixture { server: DashboardServer; db: DatabaseManager; url: string }
const fixtures: Fixture[] = [];

async function boot(db: DatabaseManager, dataDir: string): Promise<Fixture> {
  const server = new DashboardServer(db, { port: 0, dataDir }, logger);
  await server.start();
  const fx = { server, db, url: `http://127.0.0.1:${server.getPort()}` };
  fixtures.push(fx);
  return fx;
}

const audioTime = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).currentTime);
const audioReady = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => ((document.querySelector('audio') as HTMLAudioElement | null)?.readyState ?? 0) >= 1);

let demo: Fixture;
let empty: Fixture;
let mallado: number;

test.beforeAll(async () => {
  const seeded = seedDemo(path.join(tmp, 'demo'), logger);
  demo = await boot(new DatabaseManager(seeded.dbPath, logger), seeded.dataDir);
  mallado = demo.db.getRecordingByTranscriptId('simulacion_clase2_mallado')!.id;
  empty = await boot(new DatabaseManager(path.join(tmp, 'empty.db'), logger), path.join(tmp, 'empty-data'));
});

test.afterAll(async () => {
  for (const f of fixtures) { await f.server.stop(); f.db.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test.describe('Empty library', () => {
  test('shows the title, empty state, zero stats and filters', async ({ page }) => {
    await page.goto(empty.url);
    await expect(page).toHaveTitle(/LectureVault — Campus/);
    await expect(page.locator('.empty-state')).toBeVisible();
    for (const id of ['total', 'new', 'seen', 'processed']) await expect(page.locator(`#stat-${id}`)).toHaveText('0');
    for (const f of ['all', 'new', 'seen', 'processed']) {
      const btn = page.locator(`.filter-btn[data-filter="${f}"]`);
      await expect(btn).toBeVisible();
      await btn.click();
    }
  });

  test('health and recordings API', async ({ request }) => {
    expect((await (await request.get(`${empty.url}/api/health`)).json()).status).toBe('ok');
    const json = await (await request.get(`${empty.url}/api/recordings`)).json();
    expect(json.recordings).toEqual([]);
    expect(json.stats.total).toBe(0);
  });
});

test.describe('Library', () => {
  test('groups classes by course with study progress', async ({ page }) => {
    await page.goto(demo.url);
    await expect(page.locator('#stat-total')).toHaveText('7');
    await page.waitForSelector('table tbody tr');
    await expect(page.locator('.course-block')).toHaveCount(3);
    await expect(page.locator('.course-block', { hasText: 'Simulación FEM' })).toContainText('2 de 3 con apuntes');
    await expect(page.locator('.mini-alert').first()).toBeVisible();
  });

  test('filters by course from the sidebar and by status', async ({ page }) => {
    await page.goto(demo.url);
    await page.locator('.course-link', { hasText: 'Estructuras' }).click();
    await expect(page.locator('.course-block')).toHaveCount(1);
    await page.locator('.filter-btn[data-filter="new"]').click();
    await expect(page.locator('table tbody tr')).toHaveCount(1);
  });
});

test.describe('Recording', () => {
  test('notes render with math and clickable timestamps that seek the audio', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}`);
    await expect(page.locator('.prose h1')).toContainText('Mallado');
    await expect(page.locator('.prose .katex').first()).toBeVisible();
    await audioReady(page);

    await page.locator('.prose button.ts', { hasText: '01:09' }).first().click();
    await expect.poll(() => audioTime(page)).toBeGreaterThan(68);
    await expect(page.locator('.seg.is-current')).toContainText('Para definir las restricciones');
  });

  test('every [mm:ss] in the notes becomes a clickable timestamp (regression: shared /g regex)', async ({ page }) => {
    const { notes } = await (await page.request.get(`${demo.url}/api/recordings/${mallado}`)).json();
    const expected = (notes.markdown.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g) ?? []).length;
    expect(expected).toBeGreaterThan(10);
    await page.goto(`${demo.url}/#/r/${mallado}`);
    await expect(page.locator('.prose button.ts')).toHaveCount(expected);
    expect(await page.locator('.prose').innerText()).not.toMatch(/\[\d{1,2}:\d{2}\]/);
  });

  test('transcript click seeks and ?t= deep links position the player', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?t=80`);
    await audioReady(page);
    await expect.poll(() => audioTime(page)).toBeGreaterThan(79);
    await expect(page.locator('.seg.is-current')).toBeVisible();
    // following the audio scrolls the transcript panel, never the whole page
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(50);
    await page.locator('.seg', { hasText: 'Después aplicamos la carga' }).click(); // starts at 01:32
    await expect.poll(() => audioTime(page)).toBeGreaterThan(91);
  });

  test('alerts tab: timeline markers and confirming an alert', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}`);
    await expect(page.locator('.marker')).toHaveCount(6);
    await page.locator('.tab', { hasText: 'Avisos' }).click();
    await page.locator('.alert').first().getByRole('button', { name: /Confirmar/ }).click();
    await expect(page.locator('.alert .tick').first()).toBeVisible();
  });

  test('class without audio or notes explains what to do', async ({ page }) => {
    const id = demo.db.getRecordingByTranscriptId('materiales_clase1_traccion')!.id;
    await page.goto(`${demo.url}/#/r/${id}`);
    await expect(page.locator('.no-audio')).toBeVisible();
    await expect(page.locator('.prose')).toContainText('Aún no hay apuntes');
    await page.locator('.seg').first().click(); // must not throw without audio
  });

  test('malicious Markdown in notes is sanitised (no script execution)', async ({ page }) => {
    const id = demo.db.getRecordingByTranscriptId('materiales_clase1_traccion')!.id;
    new StudyRepository(demo.db.handle).saveNotes(id, [
      '# Notas', '<img src=x onerror="window.__pwned=1">', '<script>window.__pwned=2</script>',
      '[click](javascript:window.__pwned=3)', '<iframe src="https://evil.example"></iframe>', 'Texto seguro [00:05]',
    ].join('\n\n'), 'test', '2');
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.goto(`${demo.url}/#/r/${id}`);
    await expect(page.locator('.prose')).toContainText('Texto seguro');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.locator('.prose iframe, .prose script').count()).toBe(0);
    expect(await page.locator('.prose a[href^="javascript"]').count()).toBe(0);
    expect(dialogs).toEqual([]);
  });
});

test.describe('Search, agenda, study, ask', () => {
  test('search-as-you-type finds accents and typos with the exact minute', async ({ page }) => {
    await page.goto(demo.url);
    await page.locator('#global-search').fill('construccion');
    await page.waitForURL(/#\/search\?q=construccion/);
    await page.locator('#global-search').fill('ansis');
    await expect(page.locator('.hint-bar')).toContainText('ansys');
    await page.locator('.hit', { hasText: 'restricciones' }).first().click();
    await expect(page).toHaveURL(/#\/r\/\d+\?t=\d+/);
  });

  test('"/" focuses search from anywhere', async ({ page }) => {
    await page.goto(`${demo.url}/#/agenda`);
    await page.keyboard.press('/');
    await expect(page.locator('#global-search')).toBeFocused();
  });

  test('agenda shows the month calendar and exports ics', async ({ page, request }) => {
    await page.goto(`${demo.url}/#/agenda`);
    await expect(page.locator('.cal-day')).not.toHaveCount(0);
    await expect(page.locator('.alert').first()).toBeVisible();
    const ics = await request.get(`${demo.url}/api/calendar.ics`);
    expect(ics.headers()['content-type']).toContain('text/calendar');
    expect(await ics.text()).toContain('BEGIN:VEVENT');
  });

  test('flashcard review flow with keyboard shortcuts', async ({ page }) => {
    await page.goto(`${demo.url}/#/study`);
    await expect(page.locator('.flash-progress')).toContainText('1 /');
    await page.keyboard.press('Space');
    await expect(page.locator('.flashcard .answer, .flashcard .cloze-ans').first()).toBeVisible();
    await page.keyboard.press('2');
    await expect(page.locator('.flash-progress')).toContainText('2 /');
    await expect(page.locator('.flash-progress')).toContainText('1 ✓');
  });

  test('toggling practice mode does not stack keyboard handlers (regression)', async ({ page }) => {
    await page.goto(`${demo.url}/#/study`);
    // wait for each re-render to land, so the keys below hit the final state
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Volver al repaso');
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Practicar todas');
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Volver al repaso');
    await expect(page.locator('.flash-progress')).toContainText('1 /');
    await page.keyboard.press('Space');
    await page.keyboard.press('2');
    await expect(page.locator('.flash-progress')).toContainText('2 /');
    await expect(page.locator('.flash-progress')).toContainText('1 ✓');
  });

  test('dismissed alerts survive a reload and can be restored', async ({ page }) => {
    await page.goto(`${demo.url}/#/agenda`);
    const first = page.locator('.alert').first();
    const text = await first.locator('.txt').innerText();
    await first.getByRole('button', { name: /Descartar/ }).click();
    await expect(page.locator('.alert', { hasText: text })).toHaveCount(0);
    await page.reload();
    await page.locator('#show-done').check();
    const dismissed = page.locator('.alert.is-done', { hasText: text });
    await expect(dismissed).toBeVisible();
    await dismissed.getByRole('button', { name: 'Restaurar' }).click();
    await expect(page.locator('.alert.is-done', { hasText: text })).toHaveCount(0);
  });

  test('ask works without an AI key by showing relevant fragments', async ({ page }) => {
    await page.goto(`${demo.url}/#/ask`);
    await page.locator('#ask-input').fill('¿Qué peso tiene la práctica de CYPE?');
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page.locator('.msg-a .cite').first()).toContainText('CYPE');
    await page.locator('.msg-a .cite').first().click();
    await expect(page).toHaveURL(/#\/r\/\d+\?t=/);
  });
});

test.describe('Responsive', () => {
  for (const [name, route] of [['library', '/#/'], ['recording', '/#/r/MALLADO'], ['agenda', '/#/agenda'], ['study', '/#/study']] as const) {
    test(`${name} has no horizontal overflow on a phone`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(demo.url + route.replace('MALLADO', String(mallado)));
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});
