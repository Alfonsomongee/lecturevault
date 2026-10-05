import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import type { Logger } from 'pino';
import fs from 'node:fs';
import path from 'node:path';

export interface BrowserManagerConfig {
  profileDir: string;
  headed: boolean;
  viewportWidth: number;
  viewportHeight: number;
  timeoutMs: number;
  screenshotDir: string;
}

/**
 * Manages a Playwright Chromium persistent context, providing capabilities for
 * navigation, screenshots, and graceful lifecycle management.
 */
export class BrowserManager {
  private config: BrowserManagerConfig;
  private logger: Logger;
  private context: BrowserContext | null = null;

  /**
   * Constructs a new BrowserManager instance.
   *
   * @param config - The configuration for the browser manager.
   * @param logger - The pino Logger instance.
   */
  constructor(config: BrowserManagerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Launches the persistent Chromium browser context.
   * Creates necessary directories if they do not exist.
   *
   * @returns A promise that resolves to the Playwright BrowserContext.
   */
  async launch(): Promise<BrowserContext> {
    this.logger.info({ profileDir: this.config.profileDir }, 'Creating profile directory if needed');
    fs.mkdirSync(this.config.profileDir, { recursive: true });

    this.logger.info({ screenshotDir: this.config.screenshotDir }, 'Creating screenshot directory if needed');
    fs.mkdirSync(this.config.screenshotDir, { recursive: true });

    this.logger.info('Launching Chromium persistent context');
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: !this.config.headed,
      viewport: {
        width: this.config.viewportWidth,
        height: this.config.viewportHeight,
      },
    });

    this.context.setDefaultNavigationTimeout(this.config.timeoutMs);
    
    this.logger.info('Chromium context launched successfully');
    return this.context;
  }

  /**
   * Retrieves the first active page in the browser context, or creates a new one
   * if none exist.
   *
   * @returns A promise that resolves to a Playwright Page.
   * @throws If the browser context has not been launched yet.
   */
  async getPage(): Promise<Page> {
    if (!this.context) {
      throw new Error('BrowserContext not launched. Call launch() first.');
    }

    const pages = this.context.pages();
    if (pages.length > 0) {
      return pages[0]!;
    }

    this.logger.info('No existing pages found, creating a new page');
    return await this.context.newPage();
  }

  /**
   * Captures a screenshot of the current page and saves it with a timestamped prefix.
   *
   * @param name - A descriptive name for the screenshot.
   * @returns A promise that resolves when the screenshot has been saved.
   */
  async screenshot(name: string): Promise<void> {
    if (!this.context) {
      this.logger.warn('Cannot take screenshot: BrowserContext not launched');
      return;
    }

    try {
      const page = await this.getPage();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${timestamp}-${name}.png`;
      const filepath = path.join(this.config.screenshotDir, filename);

      this.logger.info({ filepath }, 'Taking screenshot');
      await page.screenshot({ path: filepath, fullPage: true });
    } catch (error) {
      this.logger.error({ err: error, name }, 'Failed to take screenshot');
    }
  }

  /**
   * Wraps an asynchronous function execution. If the function throws an error,
   * a screenshot is automatically taken before re-throwing the error.
   *
   * @param name - A descriptive name for the screenshot if an error occurs.
   * @param fn - The asynchronous function to execute.
   * @returns A promise that resolves with the function's result or rejects with its error.
   */
  async screenshotOnError<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.logger.error({ err: error, name }, `Error in ${name}, taking screenshot`);
      await this.screenshot(`error-${name}`);
      throw error;
    }
  }

  /**
   * Gracefully closes the browser context if it is running.
   */
  async close(): Promise<void> {
    if (this.context) {
      this.logger.info('Closing Chromium context');
      await this.context.close();
      this.context = null;
      this.logger.info('Chromium context closed successfully');
    }
  }

  /**
   * Registers SIGINT and SIGTERM handlers to ensure the browser context
   * is properly closed when the application terminates.
   */
  setupGracefulShutdown(): void {
    const shutdown = async () => {
      this.logger.info('Received shutdown signal, closing browser');
      await this.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
    this.logger.info('Registered graceful shutdown handlers');
  }
}
