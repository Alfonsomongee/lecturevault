/**
 * Safe Diagnostic and Sanitization Utilities
 *
 * Captures sanitized DOM snapshots and optional screenshots
 * with strict redaction of sensitive data, tokens, passwords, and cookies.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page, Locator } from 'playwright';
import type { Logger } from 'pino';

export interface DiagnosticsOptions {
  diagnosticsDir: string;
  enableDiagnostics: boolean;
  screenshotDiagnostics: boolean;
  logger: Logger;
}

export class DiagnosticsManager {
  private options: DiagnosticsOptions;

  constructor(options: DiagnosticsOptions) {
    this.options = options;
  }

  /**
   * Sanitizes HTML string by removing:
   * - script tags, inline scripts, event handlers
   * - input values, password fields, hidden tokens
   * - authorization/cookie/session tokens in attributes or text
   * - URLs with sensitive query parameters
   */
  public static sanitizeHtml(rawHtml: string): string {
    let sanitized = rawHtml;

    // Remove script tags and style tags
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '<!-- [REDACTED SCRIPT] -->');
    sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '<!-- [REDACTED STYLE] -->');

    // Redact input values, especially passwords, tokens
    sanitized = sanitized.replace(/value=(?:"[^"]*"|'[^']*')/gi, 'value="[REDACTED]"');

    // Redact sensitive attributes (tokens, authorization, credentials, session, cookies)
    sanitized = sanitized.replace(/(data-token|data-auth|data-session|token|auth-token)=(?:"[^"]*"|'[^']*')/gi, '$1="[REDACTED]"');

    // Redact URL query parameters that might carry tokens or tickets (ticket=..., token=..., session=...)
    sanitized = sanitized.replace(/([?&](?:token|ticket|auth|session|sessionId|jwt|code|access_token)=)[^"'\s&]+/gi, '$1[REDACTED]');

    // Strip inline event handlers (onclick, onload, etc.)
    sanitized = sanitized.replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, '');

    return sanitized;
  }

  /**
   * Captures and saves a sanitized DOM snapshot of the recording table only.
   */
  public async captureTableSnapshot(page: Page, tableLocator: Locator | null, label: string = 'collab2-table'): Promise<string | null> {
    if (!this.options.enableDiagnostics) {
      return null;
    }

    try {
      fs.mkdirSync(this.options.diagnosticsDir, { recursive: true });

      let rawHtml = '';
      if (tableLocator && (await tableLocator.count()) > 0) {
        rawHtml = await tableLocator.first().evaluate(el => el.outerHTML);
      } else {
        // Fallback: search for any table, role=table, role=grid
        const fallbackEl = await page.$('table, [role="table"], [role="grid"], .recordings-table');
        if (fallbackEl) {
          rawHtml = await fallbackEl.evaluate(el => el.outerHTML);
        } else {
          this.options.logger.warn('Diagnostic capture: no table found to snapshot');
          return null;
        }
      }

      const sanitized = DiagnosticsManager.sanitizeHtml(rawHtml);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `snapshot-${timestamp}-${label}.html`;
      const filepath = path.join(this.options.diagnosticsDir, filename);

      fs.writeFileSync(filepath, sanitized, 'utf8');
      this.options.logger.info({ filepath }, 'Saved sanitized table DOM snapshot');
      return filepath;
    } catch (err) {
      this.options.logger.error({ err }, 'Failed to capture sanitized table DOM snapshot');
      return null;
    }
  }

  /**
   * Captures screenshot ONLY when explicitly enabled AND verifies page is NOT an auth page.
   */
  public async captureSafeScreenshot(page: Page, label: string = 'diagnostics'): Promise<string | null> {
    if (!this.options.enableDiagnostics || !this.options.screenshotDiagnostics) {
      return null;
    }

    try {
      const url = page.url().toLowerCase();
      // Strictly refuse to screenshot login / SSO / CAS pages
      if (url.includes('/login') || url.includes('sso') || url.includes('cas') || url.includes('auth')) {
        this.options.logger.warn({ url }, 'Diagnostic screenshot refused: page appears to be an authentication page');
        return null;
      }

      // Check if password inputs exist
      const hasPassword = await page.$('input[type="password"]').catch(() => null);
      if (hasPassword) {
        this.options.logger.warn('Diagnostic screenshot refused: password input detected on page');
        return null;
      }

      fs.mkdirSync(this.options.diagnosticsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `diag-${timestamp}-${label}.png`;
      const filepath = path.join(this.options.diagnosticsDir, filename);

      await page.screenshot({ path: filepath, fullPage: false });
      this.options.logger.info({ filepath }, 'Saved diagnostic screenshot');
      return filepath;
    } catch (err) {
      this.options.logger.error({ err }, 'Failed to capture diagnostic screenshot');
      return null;
    }
  }
}
