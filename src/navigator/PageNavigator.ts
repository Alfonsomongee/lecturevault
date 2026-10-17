import type { Page } from 'playwright';
import type { Logger } from 'pino';
import type { PageState } from '../types.js';

export interface NavigatorConfig {
  lmsBaseUrl: string;
  collabRecordingsPath: string;
  allowedHosts?: string[];
  timeoutMs: number;
  screenshotDir: string;
}

/**
 * Handles navigation and page state detection for Collab2 recording pages.
 */
export class PageNavigator {
  private page: Page;
  private config: NavigatorConfig;
  private logger: Logger;
  private allowedHosts: Set<string>;

  /**
   * Creates a new PageNavigator.
   * 
   * @param page - The Playwright Page instance
   * @param config - Navigation configuration
   * @param logger - Pino logger instance
   */
  constructor(page: Page, config: NavigatorConfig, logger: Logger) {
    this.page = page;
    this.config = config;
    this.logger = logger;

    // Strict list of explicit hosts, in lowercase
    const hosts = (config.allowedHosts && config.allowedHosts.length > 0)
      ? config.allowedHosts
      : [new URL(config.lmsBaseUrl).hostname];

    this.allowedHosts = new Set(hosts.map(h => h.toLowerCase()));
  }

  /**
   * Validates that a URL belongs strictly to the allowed list of explicit hosts.
   * Does NOT use wildcard domains or endswith matching to avoid weakening security.
   * 
   * @param url - The URL to check
   * @returns boolean True if allowed, false otherwise
   */
  public isAllowedUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const host = parsedUrl.hostname.toLowerCase();
      return this.allowedHosts.has(host);
    } catch {
      return false;
    }
  }

  /**
   * Returns the list of currently allowed hosts.
   */
  public getAllowedHosts(): string[] {
    return Array.from(this.allowedHosts);
  }

  /**
   * Removes query parameters from a URL for safe logging.
   * 
   * @param urlString - The URL string
   * @returns Safe URL string without query parameters
   */
  private sanitizeUrl(urlString: string): string {
    try {
      const url = new URL(urlString);
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return 'invalid-url';
    }
  }

  /**
   * Navigates to the recordings URL and returns the detected page state.
   * 
   * @returns Promise<PageState>
   */
  public async navigateToRecordings(): Promise<PageState> {
    const targetUrl = new URL(this.config.collabRecordingsPath, this.config.lmsBaseUrl).toString();

    if (!this.isAllowedUrl(targetUrl)) {
      this.logger.error(
        { url: this.sanitizeUrl(targetUrl) },
        'Navigation blocked: Target URL is outside allowed domain'
      );
      return 'error';
    }

    this.logger.info({ url: this.sanitizeUrl(targetUrl) }, 'Navigating to recordings page');

    try {
      await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs });
      return await this.detectPageState();
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to navigate to recordings page');
      return 'error';
    }
  }

  /**
   * Inspects the current page DOM to determine its state.
   * 
   * @returns Promise<PageState>
   */
  public async detectPageState(): Promise<PageState> {
    try {
      const url = this.page.url();
      
      // 1. Auth required detection
      const isLoginUrl = url.toLowerCase().includes('/login') || 
                         url.toLowerCase().includes('sso') || 
                         url.toLowerCase().includes('cas');
      
      const hasPasswordField = await this.page.$('input[type="password"]').catch(() => null);
      const hasLoginForm = await this.page.$('#loginForm, .login-page').catch(() => null);

      if (isLoginUrl || hasPasswordField || hasLoginForm) {
        return 'auth-required';
      }

      // 2. Recordings loaded detection: check for Collab2 table or typical list containers
      const collab2Table = await this.page.$('table, [role="table"], [role="grid"]').catch(() => null);
      if (collab2Table) {
        const text = await collab2Table.textContent().catch(() => '');
        if (text && (text.includes('Nombre') || text.includes('Duración') || text.includes('Reproducir') || text.includes('Duration'))) {
          return 'recordings-loaded';
        }
      }

      const hasRecordings = await this.page.$(
        '[data-recording-id], tr.recording, .bb-collab-recording-list, .recordings-list, tbody tr'
      ).catch(() => null);
      if (hasRecordings) {
        return 'recordings-loaded';
      }

      // 3. Empty state detection
      const hasEmptyState = await this.page.$(
        '.empty-recordings, .no-recordings, [data-test="no-recordings"], .empty-state'
      ).catch(() => null);
      if (hasEmptyState) {
        return 'empty-state';
      }

      // 4. Error state detection
      const hasError = await this.page.$('.error-message, .alert-danger').catch(() => null);
      if (hasError) {
        return 'error';
      }

      return 'unknown';
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Error detecting page state');
      return 'error';
    }
  }

  /**
   * Waits for the user to authenticate manually, by polling the page state.
   * 
   * @param maxWaitMs - Maximum time to wait in milliseconds (default 5 minutes)
   * @returns Promise<boolean> True if auth succeeded, false if timed out
   */
  public async waitForUserAuth(maxWaitMs: number = 300000): Promise<boolean> {
    this.logger.info('Authentication required. Please log in manually in the browser.');
    
    const startTime = Date.now();
    const pollIntervalMs = 3000;
    
    while (Date.now() - startTime < maxWaitMs) {
      const state = await this.detectPageState();
      
      if (state !== 'auth-required') {
        this.logger.info('Authentication completed.');
        return true;
      }
      
      // Sleep without interacting with the page
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    
    this.logger.error('Timeout waiting for user authentication');
    return false;
  }

  /**
   * Waits for recording elements to appear in the DOM.
   * 
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise<boolean> True if loaded, false if timed out
   */
  public async waitForRecordingsLoaded(timeoutMs?: number): Promise<boolean> {
    const timeout = timeoutMs ?? this.config.timeoutMs;
    
    try {
      // Waiting for typical recording container/element selectors
      await this.page.waitForSelector('[data-recording-id], tr.recording, .bb-collab-recording-list, .recordings-list', {
        state: 'attached',
        timeout
      });
      return true;
    } catch {
      return false;
    }
  }
}
