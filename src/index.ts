/**
 * LectureVault — Main entry point & CLI orchestrator
 *
 * Supported Commands:
 *   npx tsx src/index.ts accept-manual  — Guided manual acceptance test (opens Chromium, lets user log in & navigate, confirms table, extracts Collab2 recordings)
 *   npx tsx src/index.ts sync           — Scrape recordings from Collab2 (automated flow)
 *   npx tsx src/index.ts serve          — Start the local dashboard
 *   npx tsx src/index.ts sync-and-serve — Scrape then start dashboard
 *   npx tsx src/index.ts ingest         — Import data/transcripts into SQLite (search, notes)
 *   npx tsx src/index.ts study          — Generate notes, alerts, flashcards, embeddings (Gemini)
 *   npx tsx src/index.ts search "texto" — Full-text search across all classes
 *   npx tsx src/index.ts ask "pregunta" — Ask your classes (RAG with verified citations)
 *   npx tsx src/index.ts export         — Anki files, .ics calendar, Obsidian notes
 *   npx tsx src/index.ts optimize-audio — Small Opus copies for the dashboard player
 *   npx tsx src/index.ts demo           — Demo library + dashboard (safe: separate data folder)
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
import {
  runIngest, runStudy, runSearch, runAsk, runExport, runOptimizeAudio, runDemo,
  finalizeTranscript, printReport,
} from './cli/study-commands.js';
import { StudyRepository } from './database/StudyRepository.js';
import { formatClock } from './utils/time.js';
import { TranscriptIngestor } from './library/TranscriptIngestor.js';
import type { SyncResult, RecordingRow, RecordingStatus } from './types.js';

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
  const dashboard = new DashboardServer(
    db,
    {
      port: config.dashboardPort,
      dataDir: config.dataDir,
      geminiApiKey: config.geminiApiKey,
      geminiModel: config.geminiModel,
      geminiEmbeddingModel: config.geminiEmbeddingModel,
    },
    logger
  );

  // Pick up transcripts captured since the last run so the dashboard is never stale
  try {
    const ingested = new TranscriptIngestor(db, config.dataDir, logger).ingestAll();
    if (ingested.created + ingested.linked + ingested.updatedSegments > 0) {
      logger.info(ingested, 'Transcripciones importadas al arrancar');
    }
  } catch (err) {
    logger.warn({ err }, 'No se pudieron importar transcripciones al arrancar');
  }

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

/** Helper to render a terminal progress bar */
function renderBar(pct: number, width: number = 20): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
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
  let course = '';
  let classDate = '';
  let speed = 1.0;
  let silent = false;
  let headless = false;
  let useEdge = process.env.BROWSER_CHANNEL === 'msedge';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--course' || args[i] === '-c') && args[i + 1]) {
      course = args[i + 1]!;
      i++;
    } else if (args[i] === '--date' && args[i + 1]) {
      classDate = args[i + 1]!;
      i++;
    } else if ((args[i] === '--duration' || args[i] === '-d') && args[i + 1]) {
      durationSec = parseInt(args[i + 1]!, 10) || 0;
      i++;
    } else if ((args[i] === '--model' || args[i] === '-m') && args[i + 1]) {
      model = args[i + 1]!;
      i++;
    } else if ((args[i] === '--name' || args[i] === '-n') && args[i + 1]) {
      customName = args[i + 1]!;
      i++;
    } else if ((args[i] === '--speed' || args[i] === '-s') && args[i + 1]) {
      speed = parseFloat(args[i + 1]!) || 1.0;
      i++;
    } else if (args[i] === '--silent' || args[i] === '--mute') {
      silent = true;
    } else if (args[i] === '--headless') {
      headless = true;
    } else if (args[i] === '--edge' || args[i] === '-e') {
      useEdge = true;
    }
  }

  capLogger.info('=====================================================');
  capLogger.info('🎙️ LECTUREVAULT — CAPTURA Y TRANSCRIPCIÓN AUTOMÁTICA');
  capLogger.info('=====================================================');
  capLogger.info({ allowedHosts: config.allowedHosts, durationSec, model, speed, silent, headless, browser: useEdge ? 'Microsoft Edge' : 'Chromium' }, 'Parámetros de captura');

  const browserManager = new BrowserManager(
    {
      profileDir: config.browserProfileDir,
      headed: !headless,
      viewportWidth: config.browserViewportWidth,
      viewportHeight: config.browserViewportHeight,
      timeoutMs: config.browserTimeoutMs,
      screenshotDir: config.screenshotDir,
      channel: useEdge ? 'msedge' : undefined,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        ...(silent ? ['--mute-audio'] : []),
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
    await captureManager.startCapture(hook.frame, speed);

    console.log('\n===============================================================');
    console.log('🔴 [GRABANDO AUDIO EN VIVO DEL REPRODUCTOR]');
    console.log('• Detección automática: Se detendrá solo cuando el vídeo llegue al final.');
    console.log('• Los micrófonos están 100% excluidos por diseño.');
    if (speed !== 1.0) {
      console.log(`• Velocidad acelerada: ${speed}x (captura ultrarrápida activa).`);
    }
    if (durationSec > 0) {
      console.log(`• Tiempo límite forzoso configurado: ${durationSec}s.`);
    }
    console.log('• Puedes pulsar ENTER en cualquier momento para detener manualmente.');
    console.log('===============================================================\n');

    let manualStopRequested = false;
    let autoStopTriggered = false;

    // Reactivate process.stdin if paused by previous readline confirmation
    if (process.stdin.isPaused()) {
      process.stdin.resume();
    }

    const onKeypressOrData = (chunk: Buffer | string) => {
      const s = chunk.toString();
      // Any newline, Enter (\r, \n), space, or 'q'
      if (s.includes('\r') || s.includes('\n') || s.toLowerCase().includes('q') || s.includes(' ')) {
        manualStopRequested = true;
      }
    };

    process.stdin.on('data', onKeypressOrData);

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
        const curStr = formatClock(progress.currentTime);
        const durStr = progress.duration > 0 ? formatClock(progress.duration) : '--:--';
        const remainingRealSecs = (progress.duration - progress.currentTime) / (speed > 0 ? speed : 1.0);
        const remainingStr = progress.duration > progress.currentTime
          ? formatClock(remainingRealSecs)
          : '00:00';
        const status = progress.isPaused ? '⏸️ En pausa' : '▶️ Grabando';
        const speedTag = speed !== 1.0 ? ` (${speed}x)` : '';

        process.stdout.write(
          `\r[${renderBar(progress.percentage)}] ${progress.percentage}% | ${curStr} / ${durStr} | Restante: ~${remainingStr}${speedTag} | ${status} | (ENTER para parar)   `
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
    process.stdin.removeListener('data', onKeypressOrData);

    if (manualStopRequested) {
      const p = await captureManager.getPlaybackProgress(hook.frame).catch(() => null);
      if (p && p.duration > 0 && p.currentTime < p.duration - 5) {
        console.log(`\n⚠️ Aviso: Has detenido la grabación antes de que terminara el vídeo (${formatClock(p.currentTime)} de ${formatClock(p.duration)}).`);
      } else {
        console.log('\n🛑 Detención manual confirmada.');
      }
    }

    // Stop and save
    console.log('\n⏳ Deteniendo y procesando audio...');
    const result = await captureManager.stopCapture(hook.frame, recId, speed);

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

      // Indexar la transcripción y, si hay clave de Gemini, generar apuntes, avisos y tarjetas
      const studyDb = new DatabaseManager(config.databasePath, capLogger);
      try {
        console.log('\n✨ Indexando la transcripción y preparando tu material de estudio...');
        const report = await finalizeTranscript(studyDb, config, capLogger, result.recordingId, course || undefined, classDate || undefined);
        if (report) printReport(result.recordingId, report);
        else console.log('ℹ️  Sin GEMINI_API_KEY: transcripción indexada para búsqueda. Añade la clave para generar apuntes con IA.');
        console.log('   Abre el dashboard con "npm run serve" para verlo.\n');
      } catch (aiErr) {
        capLogger.warn({ err: aiErr }, 'No se pudo completar el procesado de estudio');
        console.warn('⚠️ Aviso: no se pudo procesar con IA:', aiErr instanceof Error ? aiErr.message : aiErr);
      } finally {
        studyDb.close();
      }
    }

  } catch (err) {
    capLogger.error({ err }, 'Error durante el proceso de captura');
    console.error('\n❌ Error durante la captura:', err instanceof Error ? err.message : err);
  } finally {
    console.log('\nCerrando navegador...\n');
    await browserManager.close();
  }
}

/**
 * Automated Batch Transcription Pipeline:
 * Processes recordings in batch directly from the local database:
 * - Queries recordings filtered by status ('new' by default), course, limit, from, to
 * - Opens persistent browser session once (with optional --silent and --headless)
 * - Navigates to each recording or launches playback from Collab table
 * - Accelerates playback (e.g. 2x, 4x, 8x)
 * - Captures digital audio stream
 * - Automatically detects end of video
 * - Restores audio duration and pitch with FFmpeg (atempo filter)
 * - Transcribes via faster-whisper
 * - Refines notes via Gemini AI (if GEMINI_API_KEY is present)
 * - Updates SQLite status to 'processed'
 * - Loops to next item until all finished
 */
async function runBatchTranscribe(
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const batchLogger = logger.child({ component: 'batch-transcribe' });

  // Parse command line arguments
  const args = process.argv.slice(3);
  let speed = 1.0;
  let silent = false;
  let headless = false;
  let useEdge = process.env.BROWSER_CHANNEL === 'msedge';
  let statusFilter: RecordingStatus | 'all' = 'new';
  let limit = 0;
  let fromIdx = 0;
  let toIdx = 0;
  let courseFilter = '';
  let model = 'small';
  let dryRun = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      help = true;
    } else if ((args[i] === '--speed' || args[i] === '-s') && args[i + 1]) {
      speed = parseFloat(args[i + 1]!) || 1.0;
      i++;
    } else if (args[i] === '--silent' || args[i] === '--mute') {
      silent = true;
    } else if (args[i] === '--headless') {
      headless = true;
    } else if (args[i] === '--edge' || args[i] === '-e') {
      useEdge = true;
    } else if (args[i] === '--status' && args[i + 1]) {
      statusFilter = args[i + 1]! as any;
      i++;
    } else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      limit = parseInt(args[i + 1]!, 10) || 0;
      i++;
    } else if (args[i] === '--from' && args[i + 1]) {
      fromIdx = parseInt(args[i + 1]!, 10) || 0;
      i++;
    } else if (args[i] === '--to' && args[i + 1]) {
      toIdx = parseInt(args[i + 1]!, 10) || 0;
      i++;
    } else if ((args[i] === '--course' || args[i] === '-c') && args[i + 1]) {
      courseFilter = args[i + 1]!;
      i++;
    } else if ((args[i] === '--model' || args[i] === '-m') && args[i + 1]) {
      model = args[i + 1]!;
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  if (help) {
    console.log(`
===============================================================
🎙️ LECTUREVAULT — TRANSCRIPCIÓN EN LOTE (BATCH QUEUE)
===============================================================
Uso:
  npm run batch:transcribe -- [opciones]

Opciones disponibles:
  --speed, -s <n>       Velocidad de reproducción acelerada (ej: 2, 4, 8). Por defecto: 1.0
  --silent, --mute      Silenciar altavoces en Chromium (captura interna 100% activa).
  --headless            Ejecutar Chromium en segundo plano sin ventana gráfica.
  --status <estado>     Filtrar por estado en BD: 'new' (defecto), 'seen', 'processed', 'all'.
  --course, -c <texto>  Filtrar grabaciones por asignatura o título.
  --from <n>            Comenzar a partir del índice o ID indicado.
  --to <n>              Terminar en el índice o ID indicado.
  --limit, -l <n>       Número máximo de grabaciones a procesar.
  --model, -m <nombre>  Modelo faster-whisper (tiny, base, small, medium, large). Defecto: small
  --dry-run             Muestra la cola de grabaciones sin reproducir ni grabar.
  --help, -h            Muestra esta ayuda.

Ejemplos:
  # Transcribir grabaciones nuevas a 4x de velocidad sin sonido de altavoces:
  npm run batch:transcribe -- --speed 4 --silent

  # Transcribir en segundo plano total (sin ventana y sin sonido):
  npm run batch:transcribe -- --speed 4 --silent --headless

  # Transcribir solo grabaciones de una asignatura específica:
  npm run batch:transcribe -- --course "01MUIN" --speed 2 --silent

  # Ver la lista de grabaciones pendientes sin ejecutar nada:
  npm run batch:transcribe -- --dry-run
===============================================================
`);
    return;
  }

  const db = new DatabaseManager(config.databasePath, batchLogger);
  let queue: RecordingRow[] = statusFilter === 'all'
    ? db.getAllRecordings()
    : db.getRecordingsByStatus(statusFilter);

  // Filter by course / title
  if (courseFilter.trim()) {
    const cf = courseFilter.toLowerCase().trim();
    queue = queue.filter(r => r.title.toLowerCase().includes(cf) || r.collab_id.toLowerCase().includes(cf));
  }

  // Filter by from / to
  if (fromIdx > 0 || toIdx > 0) {
    queue = queue.filter((r, idx) => {
      const pos = idx + 1;
      const afterFrom = fromIdx > 0 ? (pos >= fromIdx || r.id >= fromIdx) : true;
      const beforeTo = toIdx > 0 ? (pos <= toIdx || r.id <= toIdx) : true;
      return afterFrom && beforeTo;
    });
  }

  // Apply limit
  if (limit > 0) {
    queue = queue.slice(0, limit);
  }

  console.log('\n===============================================================');
  console.log('🎙️ LECTUREVAULT — PROCESAMIENTO EN LOTE (BATCH QUEUE)');
  console.log('===============================================================');
  console.log(`• Grabaciones en cola:    ${queue.length}`);
  console.log(`• Velocidad acelerada:   ${speed}x ${speed > 1 ? `(ahorro de tiempo: ~${((1 - 1 / speed) * 100).toFixed(0)}%)` : ''}`);
  console.log(`• Modo de audio:         ${silent ? '🤫 Silencioso (--mute-audio activo)' : '🔊 Altavoces activos'}`);
  console.log(`• Modo ventana:          ${headless ? '👻 Headless (segundo plano invisible)' : '🖥️ Gráfico (ventana Chromium)'}`);
  console.log(`• Modelo transcripción:  faster-whisper (${model})`);
  console.log(`• Refinado con IA:       ${config.geminiApiKey ? '✨ Gemini AI Studio activo' : '❌ Desactivado (sin GEMINI_API_KEY)'}`);
  console.log('===============================================================\n');

  if (queue.length === 0) {
    console.log('ℹ️ No hay grabaciones pendientes que coincidan con los filtros.');
    console.log(`• Filtro de estado: "${statusFilter}" | Asignatura: "${courseFilter || 'todas'}"`);
    console.log('• Ejecuta "npm run sync" para sincronizar o usa "--status all".\n');
    db.close();
    return;
  }

  if (dryRun) {
    console.log('📋 Grabaciones que se procesarían:');
    queue.forEach((r, idx) => {
      console.log(`  [${idx + 1}] ID: ${r.collab_id} | ${r.title} | ${Math.round(r.duration_seconds / 60)} min | Estado: ${r.status}`);
      if (r.playback_url) console.log(`      URL: ${r.playback_url}`);
    });
    console.log('\n(Modo --dry-run: finalizado sin cambios)\n');
    db.close();
    return;
  }

  const browserManager = new BrowserManager(
    {
      profileDir: config.browserProfileDir,
      headed: !headless,
      viewportWidth: config.browserViewportWidth,
      viewportHeight: config.browserViewportHeight,
      timeoutMs: config.browserTimeoutMs,
      screenshotDir: config.screenshotDir,
      channel: useEdge ? 'msedge' : undefined,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        ...(silent ? ['--mute-audio'] : []),
      ],
    },
    batchLogger
  );

  browserManager.setupGracefulShutdown();

  let successCount = 0;
  const failedItems: { title: string; collabId: string; error: string }[] = [];

  try {
    batchLogger.info('Lanzando sesión de navegador para procesamiento en lote...');
    const context = await browserManager.launch();
    const mainPage = await browserManager.getPage();

    for (let i = 0; i < queue.length; i++) {
      const rec = queue[i]!;
      console.log(`\n===============================================================`);
      console.log(`▶️ [${i + 1}/${queue.length}] PROCESANDO: "${rec.title}"`);
      console.log(`• ID:       ${rec.collab_id}`);
      console.log(`• Duración: ~${Math.round(rec.duration_seconds / 60)} min`);
      console.log(`• Velocidad: ${speed}x`);
      console.log(`===============================================================`);

      let playerPage = mainPage;
      const captureManager = new AudioCaptureManager(playerPage, context, batchLogger, {
        allowedHosts: config.allowedHosts,
      });

      try {
        const hasDirectUrl = rec.playback_url && (rec.playback_url.startsWith('http://') || rec.playback_url.startsWith('https://'));

        if (hasDirectUrl) {
          batchLogger.info({ url: rec.playback_url }, 'Navegando a la URL directa de la grabación...');
          await playerPage.goto(rec.playback_url, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
        } else {
          // Navegar a la página de grabaciones de Collaborate
          const curUrl = playerPage.url();
          if (!curUrl.includes('collab') && !curUrl.includes('bbcollab')) {
            const lmsUrl = config.lmsBaseUrl.endsWith('/') ? config.lmsBaseUrl.slice(0, -1) : config.lmsBaseUrl;
            const recPath = config.collabRecordingsPath.startsWith('/') ? config.collabRecordingsPath : `/${config.collabRecordingsPath}`;
            const collabTableUrl = `${lmsUrl}${recPath}`;
            batchLogger.info({ collabTableUrl }, 'Navegando a la tabla de grabaciones...');
            await playerPage.goto(collabTableUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs }).catch(() => {});
          }

          // Localizar la fila en la tabla y hacer clic en reproducir
          batchLogger.info({ title: rec.title }, 'Buscando elemento en la tabla de Collaborate...');
          let launched = false;
          const frames = [playerPage, ...playerPage.frames()];
          for (const frame of frames) {
            try {
              const row = frame.locator(`tr:has-text("${rec.title}"), [role="row"]:has-text("${rec.title}")`).first();
              if ((await row.count()) > 0) {
                const playBtn = row.locator('button, [role="button"], .icon-button, [aria-label*="play" i], [title*="reproduc" i], span:has-text("play_circle")').first();
                if ((await playBtn.count()) > 0) {
                  const [popup] = await Promise.all([
                    context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
                    playBtn.click({ timeout: 5000 }).catch(() => {}),
                  ]);
                  if (popup) {
                    playerPage = popup;
                    await popup.waitForLoadState('domcontentloaded').catch(() => {});
                    if (popup.url().startsWith('http')) {
                      db.upsertRecording({
                        collabId: rec.collab_id,
                        title: rec.title,
                        createdAt: rec.created_at,
                        durationSeconds: rec.duration_seconds,
                        playbackUrl: popup.url(),
                      });
                    }
                  }
                  launched = true;
                  break;
                }
              }
            } catch (_) {}
          }

          if (!launched) {
            throw new Error(`No se pudo encontrar la fila o el botón de reproducción para "${rec.title}"`);
          }
        }

        // Detectar reproductor activo y esperar a que el vídeo esté disponible
        console.log('⏳ Esperando a que el reproductor de vídeo cargue...');
        const activePage = await captureManager.findActivePlayerPage();
        let hook = await captureManager.injectCaptureHook(activePage);
        let waitElapsed = 0;

        while (!hook.found && waitElapsed < 30000) {
          await new Promise((r) => setTimeout(r, 2000));
          waitElapsed += 2000;
          const candidatePage = await captureManager.findActivePlayerPage();
          hook = await captureManager.injectCaptureHook(candidatePage);
        }

        if (!hook.found) {
          throw new Error('No se detectó elemento de audio/vídeo tras 30 segundos de espera.');
        }

        // Iniciar captura acelerada
        console.log(`🔴 Grabando audio digital a ${speed}x de velocidad...`);
        await captureManager.startCapture(hook.frame, speed);

        let consecutiveEndedCount = 0;
        let autoStopTriggered = false;

        while (!autoStopTriggered) {
          await new Promise((r) => setTimeout(r, 1000));
          const progress = await captureManager.getPlaybackProgress(hook.frame).catch(() => null);

          if (progress && progress.hasMedia) {
            const curStr = formatClock(progress.currentTime);
            const durStr = progress.duration > 0 ? formatClock(progress.duration) : '--:--';
            const remainingRealSecs = (progress.duration - progress.currentTime) / (speed > 0 ? speed : 1.0);
            const remainingStr = progress.duration > progress.currentTime
              ? formatClock(remainingRealSecs)
              : '00:00';
            const statusStr = progress.isPaused ? '⏸️ En pausa' : '▶️ Grabando';
            const speedTag = speed !== 1.0 ? ` (${speed}x)` : '';

            process.stdout.write(
              `\r  [${renderBar(progress.percentage)}] ${progress.percentage}% | ${curStr} / ${durStr} | Restante: ~${remainingStr}${speedTag} | ${statusStr}   `
            );

            if (progress.hasEnded && progress.duration > 0 && progress.currentTime >= progress.duration - 1.5) {
              consecutiveEndedCount++;
              if (consecutiveEndedCount >= 2) {
                autoStopTriggered = true;
                process.stdout.write('\n\n  🏁 Vídeo finalizado. Esperando búfer final de 3s...\n');
                await new Promise((r) => setTimeout(r, 3000));
                break;
              }
            } else {
              consecutiveEndedCount = 0;
            }
          }
        }

        // Detener captura y normalizar con FFmpeg
        console.log('  ⏳ Deteniendo grabación y normalizando audio (FFmpeg)...');
        const recId = captureManager.sanitizeRecordingId(rec.collab_id || rec.title);
        const captureRes = await captureManager.stopCapture(hook.frame, recId, speed);

        console.log(`  ✅ Audio capturado: ${captureRes.wavPath} (${(captureRes.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);

        // Transcribir con faster-whisper
        console.log(`  🚀 Transcribiendo con faster-whisper (${model})...`);
        // Los términos de clases anteriores de la asignatura sesgan a Whisper hacia el vocabulario correcto
        const hotwords = new StudyRepository(db.handle).courseTerms(rec.course);
        await runTranscriptionCli({
          inputFile: captureRes.wavPath,
          model,
          hotwords,
        });

        // Indexar y, si hay API Key, generar apuntes + avisos + tarjetas
        try {
          console.log('  ✨ Preparando material de estudio...');
          db.linkTranscript(rec.id, captureRes.recordingId);
          const report = await finalizeTranscript(db, config, batchLogger, captureRes.recordingId);
          if (report) printReport(rec.title, report);
        } catch (aiErr) {
          batchLogger.warn({ err: aiErr }, 'Aviso: No se pudo completar el procesado de estudio.');
        }

        // Actualizar estado en SQLite
        db.updateStatus(rec.collab_id, 'processed');
        successCount++;
        console.log(`  🎉 ¡Grabación "${rec.title}" completada y guardada como 'processed'!\n`);

      } catch (itemErr) {
        const errorMsg = itemErr instanceof Error ? itemErr.message : String(itemErr);
        batchLogger.error({ err: itemErr, recId: rec.collab_id }, `Error procesando grabación: ${rec.title}`);
        console.error(`\n  ❌ Error en esta grabación: ${errorMsg}\n`);
        failedItems.push({ title: rec.title, collabId: rec.collab_id, error: errorMsg });
      } finally {
        if (playerPage !== mainPage) {
          await playerPage.close().catch(() => {});
        }
      }
    }

  } finally {
    console.log('\n===============================================================');
    console.log('📊 RESUMEN FINAL DEL PROCESAMIENTO EN LOTE');
    console.log('===============================================================');
    console.log(`• Total analizadas:  ${queue.length}`);
    console.log(`• Exitosas:          ${successCount}`);
    console.log(`• Con errores:       ${failedItems.length}`);
    if (failedItems.length > 0) {
      console.log('• Grabaciones con error:');
      failedItems.forEach((f) => console.log(`  - [${f.collabId}] ${f.title}: ${f.error}`));
    }
    console.log('===============================================================\n');

    await browserManager.close().catch(() => {});
    db.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const command = process.argv[2] ?? 'sync-and-serve';

  logger.info({ command }, 'LectureVault starting');

  switch (command) {
    case 'batch-transcribe': {
      await runBatchTranscribe(config, logger);
      break;
    }

    case 'ingest': {
      await runIngest(config, logger);
      break;
    }

    case 'study': {
      await runStudy(config, logger);
      break;
    }

    case 'search': {
      await runSearch(config, logger);
      break;
    }

    case 'ask': {
      await runAsk(config, logger);
      break;
    }

    case 'export': {
      await runExport(config, logger);
      break;
    }

    case 'optimize-audio': {
      await runOptimizeAudio(config, logger);
      break;
    }

    case 'demo': {
      await runDemo(config, logger);
      break;
    }

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
      logger.error({ command }, 'Unknown command. Use: batch-transcribe, capture-and-transcribe, capture-audio, inspect-player, accept-manual, sync, serve, sync-and-serve, ingest, study, search, ask, export, optimize-audio or demo');
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
