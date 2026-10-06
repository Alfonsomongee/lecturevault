/**
 * LectureVault — Main entry point & CLI orchestrator
 *
 * Supported Commands:
 *   npx tsx src/index.ts accept-manual  — Guided manual acceptance test (opens Chromium, lets user log in & navigate, confirms table, extracts Collab2 recordings)
 *   npx tsx src/index.ts sync           — Scrape recordings from Collab2 (automated flow)
 *   npx tsx src/index.ts serve          — Start the local dashboard
 *   npx tsx src/index.ts sync-and-serve — Scrape then start dashboard
 */

import readline from 'node:readline';
import { loadConfig } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { BrowserManager } from './browser/BrowserManager.js';
import { PageNavigator } from './navigator/PageNavigator.js';
import { RecordingExtractor } from './extractor/RecordingExtractor.js';
import { DatabaseManager } from './database/DatabaseManager.js';
import { DashboardServer } from './dashboard/DashboardServer.js';
import { DiagnosticsManager } from './utils/diagnostics.js';
import { AudioCaptureManager } from './capture/AudioCaptureManager.js';
import { runTranscriptionCli } from './transcriber/transcribe-cli.js';
import type { SyncResult } from './types.js';

function askUserConfirmation(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Guided manual acceptance mode:
 * 1. Open visible persistent Chromium
 * 2. Let user log in and navigate manually to the Collab2 recordings page
 * 3. Never touch, read, or autofill credentials
 * 4. Wait for explicit user CLI confirmation that recordings table is visible
 * 5. Extract recordings, check allowed hosts, record diagnostic snapshot, and update SQLite
 */
async function runManualAcceptance(
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>
): Promise<SyncResult> {
  const acceptLogger = logger.child({ component: 'manual-acceptance' });
  const result: SyncResult = {
    totalFound: 0,
    newRecordings: 0,
    updatedRecordings: 0,
    errors: [],
    timestamp: new Date().toISOString(),
  };

  acceptLogger.info('=====================================================');
  acceptLogger.info('🎓 LECTUREVAULT — GUIDED MANUAL ACCEPTANCE MODE');
  acceptLogger.info('=====================================================');
  acceptLogger.info({ allowedHosts: config.allowedHosts }, 'Allowed hosts configured');

  const browserManager = new BrowserManager(
    {
      profileDir: config.browserProfileDir,
      headed: true, // Always headed for manual acceptance
      viewportWidth: config.browserViewportWidth,
      viewportHeight: config.browserViewportHeight,
      timeoutMs: config.browserTimeoutMs,
      screenshotDir: config.screenshotDir,
    },
    acceptLogger
  );

  browserManager.setupGracefulShutdown();
  const db = new DatabaseManager(config.databasePath, acceptLogger);

  const diagnostics = new DiagnosticsManager({
    diagnosticsDir: config.diagnosticsDir,
    enableDiagnostics: config.enableDiagnostics,
    screenshotDiagnostics: config.screenshotDiagnostics,
    logger: acceptLogger,
  });

  try {
    acceptLogger.info('1. Launching visible Chromium browser with persistent profile...');
    await browserManager.launch();
    const page = await browserManager.getPage();

    const navigator = new PageNavigator(
      page,
      {
        lmsBaseUrl: config.lmsBaseUrl,
        collabRecordingsPath: config.collabRecordingsPath,
        allowedHosts: config.allowedHosts,
        timeoutMs: config.browserTimeoutMs,
        screenshotDir: config.screenshotDir,
      },
      acceptLogger
    );

    acceptLogger.info('Navigating to LMS base URL...');
    try {
      await page.goto(config.lmsBaseUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
    } catch (navErr) {
      acceptLogger.warn({ err: navErr }, 'Initial navigation finished or redirected, continuing...');
    }

    console.log('\n===============================================================');
    console.log('📌 INSTRUCTIONS FOR MANUAL ACCEPTANCE:');
    console.log('1. A visible Chromium browser has been opened.');
    console.log('2. Log in manually with your university credentials and MFA (if requested).');
    console.log('   * Note: LectureVault NEVER touches or stores your credentials.');
    console.log('3. In the LMS, navigate to your course and open the Collab2 recordings view.');
    console.log('4. Ensure the table with columns (Nombre, Fecha, Duración, Reproducir) is visible.');
    console.log('===============================================================\n');

    const confirmation = await askUserConfirmation(
      '👉 Is the Collab2 recordings table visible in the browser? Press ENTER to proceed (or type "cancel"): '
    );

    if (confirmation.toLowerCase() === 'cancel') {
      acceptLogger.info('Manual acceptance canceled by user.');
      result.errors.push('Canceled by user');
      return result;
    }

    // Verify current page host against strict allowlist
    const currentUrl = page.url();
    let currentHost = '';
    try {
      currentHost = new URL(currentUrl).hostname;
    } catch {}

    acceptLogger.info({ currentHost, allowedHosts: config.allowedHosts }, 'Verifying current page host');

    if (!navigator.isAllowedUrl(currentUrl)) {
      const errorMsg = `Current page host "${currentHost}" is not in the explicit ALLOWED_HOSTS list: [${config.allowedHosts.join(', ')}]. Extraction blocked for security.`;
      acceptLogger.error(errorMsg);
      result.errors.push(errorMsg);
      return result;
    }

    acceptLogger.info({ currentHost }, 'Host verification passed: Host is explicitly allowed');

    // Extract recordings
    const extractor = new RecordingExtractor(page, acceptLogger, {
      courseIdentifier: config.courseIdentifier,
      diagnostics,
    });

    acceptLogger.info('Extracting Collab2 recording metadata...');
    const extraction = await extractor.extractRecordings();

    acceptLogger.info(
      {
        tableDetected: extraction.tableDetected,
        totalVisibleRows: extraction.totalVisibleRows,
        totalPages: extraction.totalPages,
        recordingsExtracted: extraction.recordings.length,
      },
      'Collab2 extraction statistics'
    );

    if (!extraction.tableDetected) {
      result.errors.push('Collab2 table was not detected on page');
      return result;
    }

    result.totalFound = extraction.recordings.length;

    // Database upsert
    if (extraction.recordings.length > 0) {
      const { newCount, updatedCount } = db.upsertMany(extraction.recordings);
      result.newRecordings = newCount;
      result.updatedRecordings = updatedCount;

      acceptLogger.info(
        { newRecordings: newCount, existingRecordings: updatedCount },
        'SQLite database updated with Collab2 metadata'
      );
    } else {
      acceptLogger.warn('No recordings were found in the Collab2 table');
    }

    const stats = db.getStats();
    acceptLogger.info({ databaseStats: stats }, 'Current overall database state');

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(msg);
    acceptLogger.error({ err: error }, 'Error during manual acceptance flow');
  } finally {
    console.log('\nAcceptance run complete. Closing browser...\n');
    await browserManager.close();
    db.close();
  }

  return result;
}

async function runSync(config: ReturnType<typeof loadConfig>, logger: ReturnType<typeof createLogger>): Promise<SyncResult> {
  const syncLogger = logger.child({ component: 'sync' });
  const result: SyncResult = {
    totalFound: 0,
    newRecordings: 0,
    updatedRecordings: 0,
    errors: [],
    timestamp: new Date().toISOString(),
  };

  const browserManager = new BrowserManager(
    {
      profileDir: config.browserProfileDir,
      headed: config.browserHeaded,
      viewportWidth: config.browserViewportWidth,
      viewportHeight: config.browserViewportHeight,
      timeoutMs: config.browserTimeoutMs,
      screenshotDir: config.screenshotDir,
    },
    syncLogger,
  );

  browserManager.setupGracefulShutdown();
  const db = new DatabaseManager(config.databasePath, syncLogger);

  const diagnostics = new DiagnosticsManager({
    diagnosticsDir: config.diagnosticsDir,
    enableDiagnostics: config.enableDiagnostics,
    screenshotDiagnostics: config.screenshotDiagnostics,
    logger: syncLogger,
  });

  try {
    syncLogger.info('Starting sync pipeline');
    syncLogger.info({ allowedHosts: config.allowedHosts }, 'Allowed hosts configured');

    await browserManager.launch();
    const page = await browserManager.getPage();

    const navigator = new PageNavigator(
      page,
      {
        lmsBaseUrl: config.lmsBaseUrl,
        collabRecordingsPath: config.collabRecordingsPath,
        allowedHosts: config.allowedHosts,
        timeoutMs: config.browserTimeoutMs,
        screenshotDir: config.screenshotDir,
      },
      syncLogger,
    );

    const pageState = await browserManager.screenshotOnError('navigate', async () => {
      return await navigator.navigateToRecordings();
    });

    if (pageState === 'auth-required') {
      syncLogger.info('=== AUTHENTICATION REQUIRED ===');
      syncLogger.info('Please log in to your university account in the browser window.');
      syncLogger.info('The application will wait up to 5 minutes for you to complete login.');
      syncLogger.info('===============================');

      const authSuccess = await navigator.waitForUserAuth();
      if (!authSuccess) {
        result.errors.push('Authentication timed out');
        syncLogger.error('Authentication timed out. Please try again.');
        return result;
      }

      const postAuthState = await navigator.navigateToRecordings();
      if (postAuthState === 'auth-required') {
        result.errors.push('Still requires authentication after login attempt');
        return result;
      }
    }

    if (pageState === 'error') {
      result.errors.push('Page loaded in error state');
      await browserManager.screenshot('error-page-state');
      return result;
    }

    if (pageState !== 'recordings-loaded') {
      syncLogger.info('Waiting for recordings to load...');
      const loaded = await navigator.waitForRecordingsLoaded();
      if (!loaded) {
        syncLogger.warn('Recordings did not load within timeout.');
        await browserManager.screenshot('recordings-not-loaded');
      }
    }

    // Verify current host
    const currentUrl = page.url();
    if (!navigator.isAllowedUrl(currentUrl)) {
      const err = `Current host "${new URL(currentUrl).hostname}" is not in explicit ALLOWED_HOSTS list`;
      syncLogger.error(err);
      result.errors.push(err);
      return result;
    }

    const extractor = new RecordingExtractor(page, syncLogger, {
      courseIdentifier: config.courseIdentifier,
      diagnostics,
    });

    const extraction = await browserManager.screenshotOnError('extract', async () => {
      return await extractor.extractRecordings();
    });

    result.totalFound = extraction.recordings.length;
    syncLogger.info(
      {
        tableDetected: extraction.tableDetected,
        totalRows: extraction.totalVisibleRows,
        totalPages: extraction.totalPages,
        count: extraction.recordings.length,
      },
      'Extraction result'
    );

    if (extraction.recordings.length > 0) {
      const { newCount, updatedCount } = db.upsertMany(extraction.recordings);
      result.newRecordings = newCount;
      result.updatedRecordings = updatedCount;
      syncLogger.info({ newCount, updatedCount }, 'Database updated');
    }

    const stats = db.getStats();
    syncLogger.info({ stats }, 'Current recording stats');

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(msg);
    syncLogger.error({ err: error }, 'Sync pipeline error');
  } finally {
    await browserManager.close();
    db.close();
  }

  return result;
}

async function runServe(config: ReturnType<typeof loadConfig>, logger: ReturnType<typeof createLogger>): Promise<void> {
  const db = new DatabaseManager(config.databasePath, logger);
  const dashboard = new DashboardServer(db, { port: config.dashboardPort }, logger);

  const shutdown = async () => {
    logger.info('Shutting down dashboard...');
    await dashboard.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await dashboard.start();
  logger.info(`Dashboard is running. Open http://localhost:${config.dashboardPort} in your browser.`);
}

/**
 * Guided read-only Player Capability Inspection Mode:
 * 1. Open visible persistent Chromium
 * 2. Allow user to authenticate and navigate manually
 * 3. Ask user to open one recording manually
 * 4. Wait for ENTER when player is fully visible
 * 5. Validate current host against strict explicit allowlist
 * 6. Inspect visible & accessibility-exposed playback UI elements (NEVER click controls)
 * 7. Report capabilities and save sanitized diagnostic report
 */
async function runInspectPlayer(
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const inspectLogger = logger.child({ component: 'player-inspection-cli' });

  inspectLogger.info('=====================================================');
  inspectLogger.info('🎬 LECTUREVAULT — GUIDED PLAYER CAPABILITY INSPECTION (MILESTONE 2)');
  inspectLogger.info('=====================================================');
  inspectLogger.info({ allowedHosts: config.allowedHosts }, 'Allowed hosts configured');

  const browserManager = new BrowserManager(
    {
      profileDir: config.browserProfileDir,
      headed: true,
      viewportWidth: config.browserViewportWidth,
      viewportHeight: config.browserViewportHeight,
      timeoutMs: config.browserTimeoutMs,
      screenshotDir: config.screenshotDir,
    },
    inspectLogger
  );

  browserManager.setupGracefulShutdown();

  const diagnostics = new DiagnosticsManager({
    diagnosticsDir: config.diagnosticsDir,
    enableDiagnostics: config.enableDiagnostics,
    screenshotDiagnostics: config.screenshotDiagnostics,
    logger: inspectLogger,
  });

  try {
    inspectLogger.info('1. Launching visible Chromium browser...');
    const context = await browserManager.launch();
    const page = await browserManager.getPage();

    try {
      await page.goto(config.lmsBaseUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
    } catch (e) {
      inspectLogger.warn({ err: e }, 'Initial navigation warning, continuing...');
    }

    console.log('\n===============================================================');
    console.log('📌 INSTRUCCIONES PARA LA INSPECCIÓN DEL REPRODUCTOR (HITO 2):');
    console.log('1. Se ha abierto la ventana de Chromium con tu sesión guardada.');
    console.log('2. Navega manualmente a la lista de grabaciones de Collab2.');
    console.log('3. Haz clic manualmente en UNA de las grabaciones para abrir el reproductor.');
    console.log('   (Puede abrirse en la misma pestaña, en una pestaña nueva o en una ventana emergente).');
    console.log('4. Espera a que el reproductor de vídeo/audio esté completamente cargado y visible.');
    console.log('===============================================================\n');

    const confirmation = await askUserConfirmation(
      '👉 ¿El reproductor está completamente visible en pantalla? Pulsa ENTER para inspeccionar (o escribe "cancel"): '
    );

    if (confirmation.toLowerCase() === 'cancel') {
      inspectLogger.info('Inspección cancelada por el usuario.');
      return;
    }

    inspectLogger.info('2. Iniciando inspección de capacidades en modo de solo lectura...');

    const { PlayerInspector } = await import('./browser/PlayerInspector.js');
    const inspector = new PlayerInspector(page, context, inspectLogger, {
      diagnostics,
      allowedHosts: config.allowedHosts,
    });

    const report = await inspector.inspectPlayer();
    const caps = report.capabilities;

    console.log('\n===============================================================');
    console.log('📊 INFORME DE CAPACIDADES DEL REPRODUCTOR COLLAB2 / COLLABORATE');
    console.log('===============================================================');
    console.log(`• Host verificado:                ${caps.sanitizedHost}`);
    console.log(`• Contexto de ventana:             ${caps.windowContext}`);
    console.log(`• Reproductor detectado:           ${caps.playerDetected ? '✅ SÍ' : '❌ NO'}`);
    console.log(`• Incrustado en iframe:            ${caps.isEmbeddedInIframe ? '✅ SÍ' : '❌ NO'}`);
    console.log(`• Interacción previa requerida:    ${caps.requiresUserInteractionToPlay ? '✅ SÍ (requiere clic para reproducir)' : '❌ NO'}`);
    console.log(`• Control Play / Pause visible:    ${caps.hasPlayPauseControl ? '✅ SÍ' : '❌ NO'}`);
    console.log(`• Indicador de tiempo/duración:    ${caps.hasTimeDisplay ? `✅ SÍ (${caps.visibleCurrentTimeText || '00:00'} / ${caps.visibleDurationText || 'Desconocida'})` : '❌ NO'}`);
    console.log(`• Selector de velocidad:           ${caps.hasPlaybackSpeedControl ? '✅ SÍ' : '❌ NO'}`);
    console.log(`• Botón/menú Subtítulos (CC):      ${caps.hasClosedCaptionsControl ? '✅ SÍ' : '❌ NO'}`);
    console.log(`• Estado de subtítulos:            ${caps.subtitleStatus}`);
    console.log(`• Panel o botón de Transcripción:  ${caps.hasTranscriptPanelOrButton ? '✅ SÍ' : '❌ NO'}`);
    console.log(`• Opción visible de Descarga:      ${caps.hasDownloadOption ? `✅ SÍ (${caps.downloadLabelOrType || 'Visible'})` : '❌ NO'}`);
    console.log(`• Panel de Chat / Contenido:       ${caps.hasChatOrSessionContentOption ? '✅ SÍ' : '❌ NO'}`);
    if (caps.accessibilityLabels.length > 0) {
      console.log('\n• Etiquetas de accesibilidad identificadas:');
      for (const label of caps.accessibilityLabels) {
        console.log(`   - ${label}`);
      }
    }
    if (report.diagnosticFilePath) {
      console.log(`\n📁 Snapshot saneado guardado en:   ${report.diagnosticFilePath}`);
    }
    if (report.warnings.length > 0) {
      console.log('\n⚠️ Advertencias:');
      for (const w of report.warnings) {
        console.log(`   - ${w}`);
      }
    }
    console.log('===============================================================\n');

    // Guardar informe en formato JSON saneado
    const fs = await import('node:fs');
    const path = await import('node:path');
    const diagDir = config.diagnosticsDir;
    fs.mkdirSync(diagDir, { recursive: true });
    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(diagDir, `player-capabilities-${timestampStr}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    inspectLogger.info({ reportPath }, 'Informe de capacidades guardado correctamente');

  } catch (err) {
    inspectLogger.error({ err }, 'Error durante la inspección del reproductor');
  } finally {
    console.log('Cerrando navegador...\n');
    await browserManager.close();
  }
}

/**
 * Guided Audio Capture and Automatic Transcription flow:
 * 1. Open visible Chromium persistent session
 * 2. User opens recording in Collaborate
 * 3. User starts playback and confirms in CLI
 * 4. Verify host against allowedHosts
 * 5. Inject in-browser digital audio recorder
 * 6. Capture audio (timed or until ENTER)
 * 7. Normalize WebM to 16 kHz Mono WAV via FFmpeg
 * 8. Automatically run local faster-whisper transcription
 */
async function runCaptureAndTranscribe(
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>,
  shouldTranscribe: boolean = true
): Promise<void> {
  const capLogger = logger.child({ component: 'capture-pipeline' });

  // Parse command line arguments
  const args = process.argv.slice(3);
  let durationSec = 0;
  let model = 'small';
  let customName = '';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--duration' || args[i] === '-d') && args[i + 1]) {
      durationSec = parseInt(args[i + 1]!, 10) || 0;
      i++;
    } else if ((args[i] === '--model' || args[i] === '-m') && args[i + 1]) {
      model = args[i + 1]!;
      i++;
    } else if ((args[i] === '--name' || args[i] === '-n') && args[i + 1]) {
      customName = args[i + 1]!;
      i++;
    }
  }

  capLogger.info('=====================================================');
  capLogger.info('🎙️ LECTUREVAULT — CAPTURA Y TRANSCRIPCIÓN AUTOMÁTICA');
  capLogger.info('=====================================================');
  capLogger.info({ allowedHosts: config.allowedHosts, durationSec, model }, 'Parámetros de captura');

  const browserManager = new BrowserManager(
    {
      profileDir: config.browserProfileDir,
      headed: true,
      viewportWidth: config.browserViewportWidth,
      viewportHeight: config.browserViewportHeight,
      timeoutMs: config.browserTimeoutMs,
      screenshotDir: config.screenshotDir,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--disable-web-security',
      ],
    },
    capLogger
  );

  browserManager.setupGracefulShutdown();

  try {
    capLogger.info('1. Abriendo navegador Chromium...');
    const context = await browserManager.launch();
    const page = await browserManager.getPage();

    try {
      await page.goto(config.lmsBaseUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
    } catch (e) {
      capLogger.warn({ err: e }, 'Aviso durante navegación inicial, continuando...');
    }

    console.log('\n===============================================================');
    console.log('📌 INSTRUCCIONES PARA LA CAPTURA DE AUDIO:');
    console.log('1. Se ha abierto la ventana de Chromium con tu sesión guardada.');
    console.log('2. Navega a la grabación de la clase en Collaborate.');
    console.log('3. Inicia la reproducción (Play) para verificar que el audio se escucha.');
    console.log('===============================================================\n');

    const confirmation = await askUserConfirmation(
      '👉 ¿La grabación está abierta y reproduciéndose? Pulsa ENTER para iniciar la grabación (o escribe "cancel"): '
    );

    if (confirmation.toLowerCase() === 'cancel') {
      capLogger.info('Captura cancelada por el usuario.');
      return;
    }

    const captureManager = new AudioCaptureManager(page, context, capLogger, {
      allowedHosts: config.allowedHosts,
    });

    const activePage = await captureManager.findActivePlayerPage();
    const currentUrl = activePage.url();
    let currentHost = '';
    try {
      currentHost = new URL(currentUrl).hostname.toLowerCase();
    } catch {
      currentHost = 'unknown-host';
    }

    const isHostAllowed = config.allowedHosts.map(h => h.toLowerCase()).includes(currentHost);
    if (!isHostAllowed) {
      const err = `Host "${currentHost}" no está en la lista permitida ALLOWED_HOSTS: [${config.allowedHosts.join(', ')}]. Captura cancelada por seguridad.`;
      capLogger.error(err);
      console.error(`\n❌ Error de seguridad: ${err}\n`);
      return;
    }

    capLogger.info({ currentHost }, 'Host validado correctamente.');

    // Inject capture hook
    const hook = await captureManager.injectCaptureHook(activePage);
    if (!hook.found) {
      console.error('\n❌ No se detectó ningún elemento de vídeo/audio en la página del reproductor.');
      console.error('Asegúrate de que la grabación esté abierta y el reproductor cargado.\n');
      return;
    }

    // Determine recording ID
    let recId = customName;
    if (!recId) {
      const pageTitle = await activePage.title().catch(() => '');
      const cleanTitle = pageTitle ? captureManager.sanitizeRecordingId(pageTitle) : '';
      recId = cleanTitle || `recording-${Date.now()}`;
    }

    // Start audio capture
    await captureManager.startCapture(hook.frame);

    // Helpers for time formatting and progress bar
    const formatTime = (seconds: number): string => {
      const s = Math.max(0, Math.floor(seconds));
      const hrs = Math.floor(s / 3600);
      const mins = Math.floor((s % 3600) / 60);
      const secs = s % 60;
      if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const renderBar = (pct: number, width: number = 20): string => {
      const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
      const empty = width - filled;
      return '█'.repeat(filled) + '░'.repeat(empty);
    };

    console.log('\n===============================================================');
    console.log('🔴 [GRABANDO AUDIO EN VIVO DEL REPRODUCTOR]');
    console.log('• Detección automática: Se detendrá solo cuando el vídeo llegue al final.');
    console.log('• Los micrófonos están 100% excluidos por diseño.');
    if (durationSec > 0) {
      console.log(`• Tiempo límite forzoso configurado: ${durationSec}s.`);
    }
    console.log('• Puedes pulsar ENTER en cualquier momento para detener manualmente.');
    console.log('===============================================================\n');

    let manualStopRequested = false;
    let autoStopTriggered = false;

    // Non-blocking readline listener for manual ENTER
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once('line', () => {
      manualStopRequested = true;
    });

    const startTime = Date.now();
    let consecutiveEndedCount = 0;

    // Real-time monitoring loop
    while (!manualStopRequested && !autoStopTriggered) {
      await new Promise((r) => setTimeout(r, 1000));
      if (manualStopRequested) break;

      const progress = await captureManager.getPlaybackProgress(hook.frame).catch(() => null);

      if (progress && progress.hasMedia) {
        const curStr = formatTime(progress.currentTime);
        const durStr = progress.duration > 0 ? formatTime(progress.duration) : '--:--';
        const remainingStr = progress.duration > progress.currentTime
          ? formatTime(progress.duration - progress.currentTime)
          : '00:00';
        const status = progress.isPaused ? '⏸️ En pausa' : '▶️ Grabando';

        process.stdout.write(
          `\r[${renderBar(progress.percentage)}] ${progress.percentage}% | ${curStr} / ${durStr} | Restante: ~${remainingStr} | ${status} | (ENTER para parar)   `
        );

        // Safe auto-stop verification:
        // Must be marked ended AND current time must be within 1.5s of full duration
        if (progress.hasEnded && progress.duration > 0 && progress.currentTime >= progress.duration - 1.5) {
          consecutiveEndedCount++;
          if (consecutiveEndedCount >= 2) {
            autoStopTriggered = true;
            process.stdout.write('\n\n🏁 ¡El vídeo ha llegado al final de su reproducción completa!\n');
            console.log('⏳ Asegurando búfer final de audio (3s de margen de seguridad para no cortar el final)...');
            await new Promise((r) => setTimeout(r, 3000));
            break;
          }
        } else {
          consecutiveEndedCount = 0;
        }
      }

      // Check max duration if provided
      if (durationSec > 0 && (Date.now() - startTime) / 1000 >= durationSec) {
        console.log(`\n\n⏱️ Tiempo límite fijado de ${durationSec}s alcanzado.`);
        break;
      }
    }

    rl.close();

    if (manualStopRequested) {
      const p = await captureManager.getPlaybackProgress(hook.frame).catch(() => null);
      if (p && p.duration > 0 && p.currentTime < p.duration - 5) {
        console.log(`\n⚠️ Aviso: Has detenido la grabación antes de que terminara el vídeo (${formatTime(p.currentTime)} de ${formatTime(p.duration)}).`);
      } else {
        console.log('\n🛑 Detención manual confirmada.');
      }
    }

    // Stop and save
    console.log('\n⏳ Deteniendo y procesando audio...');
    const result = await captureManager.stopCapture(hook.frame, recId);

    console.log('\n===============================================================');
    console.log('✅ CAPTURA DE AUDIO COMPLETADA');
    console.log('===============================================================');
    console.log(`• Identificador:    ${result.recordingId}`);
    console.log(`• Archivo WAV:      ${result.wavPath}`);
    console.log(`• Tamaño:           ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`• Formato:          PCM 16-bit, 16 kHz Mono (estándar Whisper)`);
    console.log('===============================================================\n');

    if (shouldTranscribe) {
      console.log('🚀 Iniciando transcripción local con faster-whisper...\n');
      await runTranscriptionCli({
        inputFile: result.wavPath,
        model,
      });
    }

  } catch (err) {
    capLogger.error({ err }, 'Error durante el proceso de captura');
    console.error('\n❌ Error durante la captura:', err instanceof Error ? err.message : err);
  } finally {
    console.log('\nCerrando navegador...\n');
    await browserManager.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const command = process.argv[2] ?? 'sync-and-serve';

  logger.info({ command }, 'LectureVault starting');

  switch (command) {
    case 'capture-audio': {
      await runCaptureAndTranscribe(config, logger, false);
      break;
    }

    case 'capture-and-transcribe': {
      await runCaptureAndTranscribe(config, logger, true);
      break;
    }

    case 'inspect-player': {
      await runInspectPlayer(config, logger);
      break;
    }

    case 'accept-manual': {
      const result = await runManualAcceptance(config, logger);
      logger.info({ result }, 'Manual acceptance run completed');
      if (result.errors.length > 0) {
        process.exit(1);
      }
      break;
    }

    case 'sync': {
      const result = await runSync(config, logger);
      logger.info({ result }, 'Sync completed');
      if (result.errors.length > 0) {
        process.exit(1);
      }
      break;
    }

    case 'serve': {
      await runServe(config, logger);
      break;
    }

    case 'sync-and-serve': {
      const result = await runSync(config, logger);
      logger.info({ result }, 'Sync completed');
      if (result.errors.length === 0 || result.totalFound > 0) {
        await runServe(config, logger);
      } else {
        logger.error('Sync failed with no recordings. Dashboard not started.');
        process.exit(1);
      }
      break;
    }

    default:
      logger.error({ command }, 'Unknown command. Use: capture-and-transcribe, capture-audio, inspect-player, accept-manual, sync, serve, or sync-and-serve');
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
