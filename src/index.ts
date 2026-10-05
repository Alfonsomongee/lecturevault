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

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const command = process.argv[2] ?? 'sync-and-serve';

  logger.info({ command }, 'LectureVault starting');

  switch (command) {
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
      logger.error({ command }, 'Unknown command. Use: accept-manual, sync, serve, or sync-and-serve');
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
