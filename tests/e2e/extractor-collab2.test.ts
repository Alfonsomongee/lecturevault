import { test, expect } from '@playwright/test';
import { RecordingExtractor } from '../../src/extractor/RecordingExtractor.js';
import pino from 'pino';

test.describe('RecordingExtractor Collab2 Real-World Table Scenarios', () => {
  const silentLogger = pino({ level: 'silent' });

  test('extracts Collab2 table with Spanish headers (Nombre, Fecha de creación, Duración, Reproducir)', async ({ page }) => {
    // Inject mock Collab2 DOM
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Collab2 - Grabaciones</title></head>
        <body>
          <div class="collab2-container">
            <h2>Grabaciones de la sesión</h2>
            <table class="recordings-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Fecha de creación</th>
                  <th>Duración</th>
                  <th>Reproducir</th>
                </tr>
              </thead>
              <tbody>
                <tr data-id="rec-001">
                  <td>Tema 1: Arquitectura del Software</td>
                  <td>14/10/2026 16:00</td>
                  <td>01:45:30</td>
                  <td><a href="https://collab2.bbcollab.com/recordings/rec-001/watch">Ver grabación</a></td>
                </tr>
                <tr data-id="rec-002">
                  <td>Tema 2: Seguridad en Sistemas Distribuidos</td>
                  <td>21/10/2026 16:00</td>
                  <td></td> <!-- Missing duration -->
                  <td><button aria-label="Reproducir grabación Tema 2" data-url="https://collab2.bbcollab.com/play/rec-002">Reproducir</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </body>
      </html>
    `);

    const extractor = new RecordingExtractor(page, silentLogger, {
      courseIdentifier: 'master-seguridad-2026',
    });

    const result = await extractor.extractRecordings();
    expect(result.tableDetected).toBe(true);
    expect(result.recordings.length).toBe(2);

    // Verify first row
    const rec1 = result.recordings[0]!;
    expect(rec1.title).toBe('Tema 1: Arquitectura del Software');
    expect(rec1.durationSeconds).toBe(6330); // 1h 45m 30s
    expect(rec1.playbackUrl).toBe('https://collab2.bbcollab.com/recordings/rec-001/watch');
    expect(rec1.collabId).toBeDefined();

    // Verify second row with missing duration
    const rec2 = result.recordings[1]!;
    expect(rec2.title).toBe('Tema 2: Seguridad en Sistemas Distribuidos');
    expect(rec2.durationSeconds).toBe(0); // missing duration handled gracefully
    expect(rec2.playbackUrl).toBe('https://collab2.bbcollab.com/play/rec-002');
  });

  test('extracts table with more than 10 recordings across pagination', async ({ page }) => {
    // Generate page 1 with 12 items and page 2 with 5 items
    let page1Rows = '';
    for (let i = 1; i <= 12; i++) {
      page1Rows += `
        <tr data-id="p1-rec-${i}">
          <td>Clase Magistral ${i}</td>
          <td>${i.toString().padStart(2, '0')}/10/2026 10:00</td>
          <td>01:00:00</td>
          <td><a href="https://collab2.bbcollab.com/play/p1-${i}">Play</a></td>
        </tr>
      `;
    }

    let page2Rows = '';
    for (let i = 13; i <= 17; i++) {
      page2Rows += `
        <tr data-id="p2-rec-${i}">
          <td>Clase Magistral ${i}</td>
          <td>${i.toString().padStart(2, '0')}/10/2026 10:00</td>
          <td>01:30:00</td>
          <td><a href="https://collab2.bbcollab.com/play/p2-${i}">Play</a></td>
        </tr>
      `;
    }

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Collab2 - Paginación</title></head>
        <body>
          <table id="collabTable">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Fecha de creación</th>
                <th>Duración</th>
                <th>Reproducir</th>
              </tr>
            </thead>
            <tbody id="tableBody">
              ${page1Rows}
            </tbody>
          </table>
          <div class="pagination">
            <button id="nextBtn" aria-label="Siguiente página">Siguiente</button>
          </div>
          <script>
            document.getElementById('nextBtn').addEventListener('click', () => {
              document.getElementById('tableBody').innerHTML = \`${page2Rows}\`;
              document.getElementById('nextBtn').disabled = true;
            });
          </script>
        </body>
      </html>
    `);

    const extractor = new RecordingExtractor(page, silentLogger, {
      courseIdentifier: 'pagination-test-course',
    });

    const result = await extractor.extractRecordings();
    expect(result.tableDetected).toBe(true);
    expect(result.totalPages).toBe(2);
    expect(result.recordings.length).toBe(17);
    expect(result.recordings[0]?.title).toBe('Clase Magistral 1');
    expect(result.recordings[16]?.title).toBe('Clase Magistral 17');
  });

  test('handles dynamically loaded rows after initial DOM render', async ({ page }) => {
    // Empty initial table, rows injected after 300ms
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body>
          <table class="collab-async-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Fecha de creación</th>
                <th>Duración</th>
                <th>Reproducir</th>
              </tr>
            </thead>
            <tbody id="asyncBody">
              <tr><td colspan="4">Cargando grabaciones...</td></tr>
            </tbody>
          </table>
          <script>
            setTimeout(() => {
              document.getElementById('asyncBody').innerHTML = \`
                <tr data-id="async-01">
                  <td>Sesión Práctica Dinámica</td>
                  <td>05/10/2026 17:00</td>
                  <td>50 min</td>
                  <td><a href="https://collab2.bbcollab.com/play/async-01">Ver</a></td>
                </tr>
              \`;
            }, 300);
          </script>
        </body>
      </html>
    `);

    // Wait for the async content to be rendered
    await page.waitForSelector('tr[data-id="async-01"]');

    const extractor = new RecordingExtractor(page, silentLogger, {
      courseIdentifier: 'async-course',
    });

    const result = await extractor.extractRecordings();
    expect(result.tableDetected).toBe(true);
    expect(result.recordings.length).toBe(1);
    expect(result.recordings[0]?.title).toBe('Sesión Práctica Dinámica');
    expect(result.recordings[0]?.durationSeconds).toBe(3000); // 50 min * 60s
  });
});
