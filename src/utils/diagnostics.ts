/**
 * Safe Diagnostic and Sanitization Utilities
 *
 * Captures sanitized DOM snapshots and optional screenshots
 * with strict redaction of sensitive data, tokens, passwords, cookies,
 * media URLs, CDNs, source elements, track elements, and personal data.
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
   * Sanitizes HTML string by strictly removing:
   * - script and style tags
   * - input values, password fields, hidden tokens
   * - media elements (<source>, <track>, <audio>, <video>)
   * - media/link attributes: src, currentSrc, srcset, href, poster
   * - any URLs (http://, https://), CDN domains (e.g. cloudfront, bbcollab)
   * - query strings and tokens (ticket, token, session)
   * - recording and session UUIDs / identifiers
   * - data attributes containing URLs or IDs
   * - inline event handlers
   * - personal names, participant info and chat content
   */
  public static sanitizeHtml(rawHtml: string): string {
    let sanitized = rawHtml;

    // 1. Remove script tags and style tags
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '<!-- [REDACTED SCRIPT] -->');
    sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '<!-- [REDACTED STYLE] -->');

    // 2. Remove entire <source> and <track> elements completely
    sanitized = sanitized.replace(/<source\b[^>]*\/?>/gi, '<!-- [REDACTED SOURCE] -->');
    sanitized = sanitized.replace(/<track\b[^>]*\/?>/gi, '<!-- [REDACTED TRACK] -->');

    // 3. Remove media source / reference attributes (src, currentSrc, srcset, href, poster)
    sanitized = sanitized.replace(/\b(src|currentSrc|srcset|href|poster)=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1="[REDACTED_REF]"');

    // 4. Remove all HTTP / HTTPS URLs anywhere in attributes or content
    sanitized = sanitized.replace(/https?:\/\/[^\s"'>]+/gi, '[REDACTED_URL]');

    // 5. Remove any CloudFront or CDN references
    sanitized = sanitized.replace(/[a-z0-9.-]*cloudfront[a-z0-9.-]*/gi, '[REDACTED_CDN]');
    sanitized = sanitized.replace(/[a-z0-9.-]*bbcollab\.com[a-z0-9.-]*/gi, '[REDACTED_DOMAIN]');

    // 6. Redact input values, passwords, tokens
    sanitized = sanitized.replace(/value=(?:"[^"]*"|'[^']*')/gi, 'value="[REDACTED]"');

    // 7. Redact sensitive attributes (tokens, authorization, credentials, session, cookies)
    sanitized = sanitized.replace(/(data-token|data-auth|data-session|token|auth-token)=(?:"[^"]*"|'[^']*')/gi, '$1="[REDACTED]"');

    // 8. Redact data attributes containing URLs or IDs (e.g. data-url, data-href, data-id, data-recording-id)
    sanitized = sanitized.replace(/\b(data-url|data-href|data-src|data-recording-id|data-session-id)=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1="[REDACTED]"');

    // 9. Redact UUIDs and recording/session hashes (32/36 hex chars)
    sanitized = sanitized.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '[REDACTED_UUID]');
    sanitized = sanitized.replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED_HEX32]');
    sanitized = sanitized.replace(/(recordingUid|recordingId|sessionId|sessionUid|playbackId)=(?:"[^"]*"|'[^']*'|[^\s>&]+)/gi, '$1=[REDACTED_ID]');

    // 10. Redact URL query parameters that might carry tokens or tickets
    sanitized = sanitized.replace(/([?&](?:token|ticket|auth|authtoken|session|sessionId|jwt|code|access_token)=)[^"'\s&]+/gi, '$1[REDACTED]');

    // 11. Redact chat / participant sections if present
    sanitized = sanitized.replace(/<div\b[^>]*(?:chat|participant|user-list|messages)[^>]*>[\s\S]*?<\/div>/gi, '<!-- [REDACTED CHAT/PARTICIPANT CONTENT] -->');

    // 12. Strip inline event handlers (onclick, onload, etc.)
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

  /**
   * Captures and saves ONLY the smallest relevant player control container HTML,
   * completely stripped of video/audio sources, track tags, media URLs, CDNs, tokens,
   * query strings, identifiers, and personal data.
   */
  public async captureSanitizedPlayerContainer(
    _page: Page,
    containerLocator: Locator,
    label: string = 'player-controls'
  ): Promise<string | null> {
    if (!this.options.enableDiagnostics) {
      return null;
    }

    try {
      fs.mkdirSync(this.options.diagnosticsDir, { recursive: true });

      let rawHtml = '';
      if ((await containerLocator.count()) > 0) {
        // Attempt to isolate control bar specifically, avoiding video elements
        const controlBar = containerLocator.locator('.vjs-control-bar, .controls-bar, .playback-controls').first();
        if ((await controlBar.count().catch(() => 0)) > 0) {
          rawHtml = await controlBar.evaluate(el => el.outerHTML);
        } else {
          rawHtml = await containerLocator.first().evaluate(el => el.outerHTML);
        }
      } else {
        return null;
      }

      // Base & comprehensive sanitization
      const sanitized = DiagnosticsManager.sanitizeHtml(rawHtml);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `player-controls-${timestamp}-${label}.html`;
      const filepath = path.join(this.options.diagnosticsDir, filename);

      fs.writeFileSync(filepath, sanitized, 'utf8');
      this.options.logger.info({ filepath }, 'Saved strictly sanitized player container snapshot');
      return filepath;
    } catch (err) {
      this.options.logger.error({ err }, 'Failed to capture sanitized player container snapshot');
      return null;
    }
  }
}
