import { test, expect, type Page } from '@playwright/test';
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

interface Fixture { server: DashboardServer; db: DatabaseManager; url: string; dataDir: string; dbPath: string }
const fixtures: Fixture[] = [];

async function boot(dbPath: string, dataDir: string): Promise<Fixture> {
  const db = new DatabaseManager(dbPath, logger);
  const server = new DashboardServer(db, { port: 0, dataDir }, logger);
  await server.start();
  const fx = { server, db, url: `http://127.0.0.1:${server.getPort()}`, dataDir, dbPath };
  fixtures.push(fx);
  return fx;
}

const audioTime = (page: Page) => page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).currentTime);
const audioReady = (page: Page) => page.waitForFunction(() => ((document.querySelector('audio') as HTMLAudioElement | null)?.readyState ?? 0) >= 1);

let demo: Fixture;
let empty: Fixture;
let mallado: number;
let materiales: number;

test.beforeAll(async () => {
  const seeded = seedDemo(path.join(tmp, 'demo'), logger);
  demo = await boot(seeded.dbPath, seeded.dataDir);
  mallado = demo.db.getRecordingByTranscriptId('simulacion_clase2_mallado')!.id;
  materiales = demo.db.getRecordingByTranscriptId('materiales_clase1_traccion')!.id;
  empty = await boot(path.join(tmp, 'empty.db'), path.join(tmp, 'empty-data'));
});

test.afterAll(async () => {
  for (const f of fixtures) { await f.server.stop(); f.db.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test.describe('Estilo', () => {
  test('la interfaz no contiene emojis', async ({ page }) => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{23E9}-\u{23FF}\u{2B50}]/u;
    for (const route of ['/', '/#/agenda', '/#/study', '/#/ask', '/#/settings', `/#/r/${mallado}`, `/#/r/${mallado}?tab=alerts`, `/#/r/${mallado}?tab=cards`]) {
      await page.goto(demo.url + route);
      await page.waitForTimeout(250);
      expect(emoji.test(await page.locator('body').innerText()), route).toBe(false);
    }
  });
});

test.describe('Biblioteca vacía', () => {
  test('muestra estado vacío y la API responde', async ({ page, request }) => {
    await page.goto(empty.url);
    await expect(page).toHaveTitle('LectureVault');
    await expect(page.locator('.empty')).toBeVisible();
    expect((await (await request.get(`${empty.url}/api/health`)).json()).status).toBe('ok');
    expect((await (await request.get(`${empty.url}/api/recordings`)).json()).recordings).toEqual([]);
  });
});

test.describe('Clases', () => {
  test('agrupa por asignatura y lista lo pendiente con el comando exacto', async ({ page }) => {
    await page.goto(demo.url);
    await expect(page.locator('h2.section', { hasText: 'Simulación FEM' })).toBeVisible();
    await expect(page.locator('table.classes')).toHaveCount(3);
    const pending = page.locator('table.pending tbody tr');
    await expect(pending).toHaveCount(2);
    const cmd = await pending.first().locator('[data-copy]').getAttribute('data-copy');
    expect(cmd).toMatch(/^npm run capture:and:transcribe -- .*--date \d{4}-\d{2}-\d{2} --name demo-collab-/);
    await pending.first().locator('[data-copy]').click();
    await expect(page.locator('.toast')).toContainText(/Comando copiado|No se pudo copiar/);
  });

  test('filtra por nombre y por asignatura, y recuerda la asignatura tras recargar', async ({ page }) => {
    await page.goto(demo.url);
    await page.locator('#filter').fill('mallado');
    await expect(page.locator('table.classes tbody tr')).toHaveCount(1);
    await page.locator('#filter').fill('');
    await page.locator('#side-courses button', { hasText: 'Estructuras' }).click();
    await expect(page.locator('table.classes')).toHaveCount(1);
    await page.reload(); // la asignatura elegida está en la base de datos, no en el navegador
    await expect(page.locator('table.classes')).toHaveCount(1);
    await page.locator('#side-courses button', { hasText: 'Todas' }).click();
    await expect(page.locator('table.classes')).toHaveCount(3);
  });

  test('mueve clases en lote a una asignatura del catálogo con solo el número', async ({ page }) => {
    fs.copyFileSync(path.resolve('courses.example.json'), path.join(demo.dataDir, 'courses.json'));
    await page.goto(demo.url);
    await expect(page.locator('#side-courses button', { hasText: '07MUIN' })).toBeVisible();
    await page.locator('tr', { hasText: 'Ensayo de tracción' }).locator('[data-sel]').check();
    await expect(page.locator('#bulk')).toBeVisible();
    await page.locator('#bulk-course').fill('07');
    await page.locator('#bulk-go').click();
    await expect(page.locator('h2.section', { hasText: '07MUIN' })).toBeVisible();
    demo.db.handle.prepare("UPDATE recordings SET course = 'Materiales' WHERE id = ?").run(materiales);
    fs.rmSync(path.join(demo.dataDir, 'courses.json'));
  });
});

test.describe('Clase', () => {
  test('los apuntes muestran fórmulas y cada [mm:ss] mueve el audio', async ({ page }) => {
    const { notes } = await (await page.request.get(`${demo.url}/api/recordings/${mallado}`)).json();
    const expected = (notes.markdown.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g) ?? []).length;
    await page.goto(`${demo.url}/#/r/${mallado}`);
    await expect(page.locator('.prose h1')).toContainText('Mallado');
    await expect(page.locator('.prose .katex').first()).toBeVisible();
    await expect(page.locator('.prose button.ts')).toHaveCount(expected);
    await audioReady(page);
    await page.locator('.prose button.ts', { hasText: '01:09' }).first().click();
    await expect.poll(() => audioTime(page)).toBeGreaterThan(68);
  });

  test('transcripción sincronizada y deep link ?t=', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?t=80&tab=transcript`);
    await audioReady(page);
    await expect.poll(() => audioTime(page)).toBeGreaterThan(79);
    await expect(page.locator('.seg.is-current')).toBeVisible();
    await page.locator('.seg', { hasText: 'Después aplicamos la carga' }).click();
    await expect.poll(() => audioTime(page)).toBeGreaterThan(91);
  });

  test('edita los apuntes: se guardan, quedan en el historial y se pueden restaurar', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}`);
    await page.locator('#edit').click();
    const original = await page.locator('#editor').inputValue();
    await page.locator('#editor').fill(`${original}\n\n## Mi anexo\n\nTexto escrito por mí sobre tolerancias [00:30]`);
    await page.keyboard.press('Control+s');
    await expect(page.locator('.prose h2', { hasText: 'Mi anexo' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.prose h2', { hasText: 'Mi anexo' })).toBeVisible();
    await page.locator('#ver').click();
    await page.locator('#ver-pop [data-v]').first().click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page.locator('.prose h2', { hasText: 'Mi anexo' })).toHaveCount(0);
  });

  test('avisos: confirmar, crear a mano y borrar; marcadores en la línea de tiempo', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?tab=alerts`);
    await expect(page.locator('#panel .item').first()).toBeVisible();
    const before = await page.locator('#panel .item').count();
    await page.locator('#panel .item').first().getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.locator('#panel .item .tag-green').first()).toBeVisible();

    await page.locator('#new-alert').click();
    await page.locator('#na-text').fill('Entregar el informe de tolerancias');
    await page.locator('#na-date').fill('2026-12-01');
    await page.locator('#alert-new button[type="submit"]').click();
    await expect(page.locator('#panel .item')).toHaveCount(before + 1);
    await page.locator('#panel .item', { hasText: 'informe de tolerancias' }).getByRole('button', { name: 'Borrar aviso' }).click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page.locator('#panel .item')).toHaveCount(before);
    await expect(page.locator('.marker').first()).toBeVisible();
  });

  test('tarjetas: crear, editar y eliminar a mano', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?tab=cards`);
    await page.locator('#new-card').click();
    await page.locator('#cf-front').fill('¿Qué es una tolerancia?');
    await page.locator('#cf-back').fill('Desviación admisible de una cota');
    await page.locator('#card-edit button[type="submit"]').click();
    await expect(page.locator('#panel .item', { hasText: 'tolerancia' })).toBeVisible();
    await page.locator('#panel .item', { hasText: 'tolerancia' }).getByRole('button', { name: 'Editar' }).click();
    await page.locator('#cf-back').fill('Variación permitida de una medida');
    await page.locator('#card-edit button[type="submit"]').click();
    await expect(page.locator('#panel .item', { hasText: 'Variación permitida' })).toBeVisible();
    await page.locator('#panel .item', { hasText: 'tolerancia' }).getByRole('button', { name: 'Eliminar' }).click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page.locator('#panel .item', { hasText: 'tolerancia' })).toHaveCount(0);
  });

  test('marcas propias y título editable se conservan al recargar', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?t=42&tab=markers`);
    await audioReady(page);
    await page.locator('#marker-text').fill('Repasar el criterio de convergencia');
    await page.locator('#marker-form button[type="submit"]').click();
    await expect(page.locator('#panel .item', { hasText: 'criterio de convergencia' })).toBeVisible();
    await page.locator('#title-input').fill('Clase 2 · Mallado (revisada)');
    await page.locator('#title-input').press('Enter');
    await expect(page.locator('.toast', { hasText: 'Guardado' }).first()).toBeVisible();
    await page.reload();
    await expect(page.locator('#title-input')).toHaveValue('Clase 2 · Mallado (revisada)');
    await expect(page.locator('#panel .item', { hasText: 'criterio de convergencia' })).toBeVisible();
  });

  test('la posición de reproducción se guarda en el servidor', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?t=100`);
    await audioReady(page);
    await page.locator('#play').click();
    await page.waitForTimeout(300);
    await page.locator('#play').click();
    await expect.poll(async () => (await (await page.request.get(`${demo.url}/api/recordings/${mallado}`)).json()).position).toBeGreaterThanOrEqual(100);
  });

  test('una clase sin audio ni apuntes lo explica y deja escribir apuntes', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${materiales}`);
    await expect(page.locator('.no-audio')).toBeVisible();
    await expect(page.locator('#panel')).toContainText('aún no tiene apuntes');
    await page.locator('#write').click();
    await page.locator('#editor').fill('# Mis apuntes\n\nEnsayo de tracción [00:10]');
    await page.locator('#save-notes').click();
    await expect(page.locator('.prose h1')).toContainText('Mis apuntes');
  });

  test('el Markdown malicioso se sanea', async ({ page }) => {
    new StudyRepository(demo.db.handle).saveNotes(materiales, [
      '# Notas', '<img src=x onerror="window.__pwned=1">', '<script>window.__pwned=2</script>',
      '[click](javascript:window.__pwned=3)', '<iframe src="https://evil.example"></iframe>', 'Texto seguro [00:05]',
    ].join('\n\n'), 'test', '2');
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.goto(`${demo.url}/#/r/${materiales}`);
    await expect(page.locator('.prose')).toContainText('Texto seguro');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.locator('.prose iframe, .prose script, .prose a[href^="javascript"]').count()).toBe(0);
    expect(dialogs).toEqual([]);
  });

  test('eliminar una clase local la quita de la lista', async ({ page }) => {
    const rec = demo.db.createLocalRecording({ transcriptId: 'para_borrar', title: 'Clase de prueba', createdAt: new Date().toISOString(), durationSeconds: 60 });
    new StudyRepository(demo.db.handle).replaceSegments(rec.id, [{ start: 0, end: 5, text: 'hola' }]);
    await page.goto(`${demo.url}/#/r/${rec.id}`);
    await page.locator('#del-files').click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('table.classes', { hasText: 'Clase de prueba' })).toHaveCount(0);
  });
});

test.describe('Búsqueda, agenda, repaso, preguntar, ajustes', () => {
  test('la búsqueda tolera acentos y errores y salta al minuto', async ({ page }) => {
    await page.goto(demo.url);
    await page.locator('#global-search').fill('construccion');
    await page.waitForURL(/#\/search\?q=construccion/);
    await page.locator('#global-search').fill('ansis');
    await expect(page.locator('.note-banner')).toContainText('ansys');
    await page.locator('.hit', { hasText: 'restricciones' }).first().click();
    await expect(page).toHaveURL(/#\/r\/\d+\?t=\d+/);
  });

  test('"/" enfoca la búsqueda desde cualquier pantalla', async ({ page }) => {
    await page.goto(`${demo.url}/#/agenda`);
    await page.keyboard.press('/');
    await expect(page.locator('#global-search')).toBeFocused();
  });

  test('agenda: lista, calendario, alta manual y exportación .ics', async ({ page, request }) => {
    await page.goto(`${demo.url}/#/agenda`);
    await expect(page.locator('.item').first()).toBeVisible();
    await page.locator('[data-mode="cal"]').click();
    await expect(page.locator('.cal-day')).not.toHaveCount(0);
    await page.locator('[data-mode="list"]').click();
    await page.locator('#new-alert').click();
    await page.locator('#na-text').fill('Examen parcial de simulación');
    await page.locator('#na-date').fill('2026-11-20');
    await page.locator('#alert-new button[type="submit"]').click();
    await expect(page.locator('.item', { hasText: 'Examen parcial de simulación' })).toBeVisible();
    const ics = await (await request.get(`${demo.url}/api/calendar.ics?confirmed=1`)).text();
    expect(ics).toContain('SUMMARY:Examen: Examen parcial de simulación');
  });

  test('los avisos descartados sobreviven a recargar y se pueden restaurar', async ({ page }) => {
    await page.goto(`${demo.url}/#/agenda`);
    const first = page.locator('.item').first();
    const text = await first.locator('.txt').innerText();
    await first.getByRole('button', { name: 'Descartar' }).click();
    await expect(page.locator('.item', { hasText: text })).toHaveCount(0);
    await page.reload();
    await page.locator('#show-done').check();
    const dismissed = page.locator('.item.is-done', { hasText: text });
    await expect(dismissed).toBeVisible();
    await dismissed.getByRole('button', { name: 'Restaurar' }).click();
    await expect(page.locator('.item.is-done', { hasText: text })).toHaveCount(0);
  });

  test('repaso con atajos de teclado y sin acumular manejadores', async ({ page }) => {
    await page.goto(`${demo.url}/#/study`);
    await expect(page.locator('.review')).toBeVisible();
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Volver al repaso');
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Practicar todas');
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Volver al repaso');
    await expect(page.locator('.review')).toContainText('1 de');
    await page.keyboard.press('Space');
    await page.keyboard.press('2');
    await expect(page.locator('.review')).toContainText('2 de');
    await expect(page.locator('.review')).toContainText('1 bien');
    await page.locator('[data-sec="all"]').click();
    await expect(page.locator('table.db tbody tr').first()).toBeVisible();
  });

  test('preguntar funciona sin clave de IA mostrando fragmentos con enlace', async ({ page }) => {
    await page.goto(`${demo.url}/#/ask`);
    await page.locator('#ask-input').fill('¿Qué peso tiene la práctica de CYPE?');
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page.locator('.a-msg .cite').first()).toContainText('CYPE');
    await page.locator('.a-msg .cite').first().click();
    await expect(page).toHaveURL(/#\/r\/\d+\?t=/);
  });

  test('ajustes: el tema vive en el servidor, copia de seguridad y catálogo editable', async ({ page, browser }) => {
    await page.goto(`${demo.url}/#/settings`);
    await page.locator('[data-theme="dark"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const fresh = await (await browser.newContext()).newPage(); // otro navegador: sin localStorage compartido
    await fresh.goto(demo.url);
    await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'dark');
    await fresh.context().close();
    await page.locator('[data-theme="light"]').click();

    await page.locator('#backup').click();
    await expect(page.locator('.toast', { hasText: 'Copia creada' })).toBeVisible();

    await page.locator('#add-course').click();
    const row = page.locator('table.catalog tbody tr').last();
    await row.locator('[data-f="code"]').fill('99TST');
    await row.locator('[data-f="name"]').fill('Asignatura de prueba');
    await page.locator('#save-courses').click();
    await expect(page.locator('#side-courses button', { hasText: '99TST' })).toBeVisible();
    fs.rmSync(path.join(demo.dataDir, 'courses.json'), { force: true });
  });
});

test.describe('Persistencia', () => {
  test('todo lo editado sobrevive a reiniciar el servidor', async ({ page }) => {
    await demo.server.stop();
    demo.db.close();
    demo = await boot(demo.dbPath, demo.dataDir);
    await page.goto(`${demo.url}/#/r/${mallado}?tab=markers`);
    await expect(page.locator('#title-input')).toHaveValue('Clase 2 · Mallado (revisada)');
    await page.goto(`${demo.url}/#/r/${materiales}`);
    await expect(page.locator('.prose')).toContainText('Texto seguro');
  });
});

test.describe('Móvil', () => {
  for (const [name, route] of [['clases', '/#/'], ['clase', '/#/r/MALLADO'], ['agenda', '/#/agenda'], ['repaso', '/#/study'], ['ajustes', '/#/settings']] as const) {
    test(`${name} no desborda horizontalmente`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(demo.url + route.replace('MALLADO', String(mallado)));
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    });
  }
});
