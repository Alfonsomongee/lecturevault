import type { Page, Frame, Locator } from 'playwright';
import type { Logger } from 'pino';
import type { RecordingMetadata } from '../types.js';
import crypto from 'node:crypto';
import type { DiagnosticsManager } from '../utils/diagnostics.js';

export interface ExtractionResult {
  recordings: RecordingMetadata[];
  totalPages: number;
  totalVisibleRows: number;
  tableDetected: boolean;
}

export interface ExtractorOptions {
  courseIdentifier?: string;
  diagnostics?: DiagnosticsManager;
}

interface TableLocation {
  container: Page | Frame;
  locator: Locator;
}

export class RecordingExtractor {
  private page: Page;
  private logger: Logger;
  private courseIdentifier: string;
  private diagnostics?: DiagnosticsManager;

  constructor(page: Page, logger: Logger, options?: ExtractorOptions) {
    this.page = page;
    this.logger = logger;
    this.courseIdentifier = options?.courseIdentifier ?? 'default-course';
    this.diagnostics = options?.diagnostics;
  }

  /**
   * Main extraction method that searches both main page and iframe contexts.
   */
  public async extractRecordings(): Promise<ExtractionResult> {
    this.logger.info('Starting Collab2 recording extraction across main page and iframes');

    const tableLocation = await this.findTableLocation();

    if (!tableLocation) {
      this.logger.warn('Collab2 recording table not detected in the current DOM or iframes.');
      return {
        recordings: [],
        totalPages: 0,
        totalVisibleRows: 0,
        tableDetected: false,
      };
    }

    const { locator: tableLocator, container } = tableLocation;
    this.logger.info('Collab2 recording table successfully located');

    // Diagnostic snapshot if enabled
    if (this.diagnostics) {
      await this.diagnostics.captureTableSnapshot(this.page, tableLocator, 'before-extraction');
      await this.diagnostics.captureSafeScreenshot(this.page, 'collab2-table-detected');
    }

    const allRecordings: RecordingMetadata[] = [];
    let pageIndex = 1;
    let hasMorePages = true;
    let totalVisibleRows = 0;

    while (hasMorePages) {
      this.logger.info({ pageIndex }, `Processing recordings page ${pageIndex}`);

      const pageRows = await this.extractRowsFromCurrentPage(tableLocator);
      totalVisibleRows += pageRows.length;

      for (const rec of pageRows) {
        allRecordings.push(rec);
      }

      this.logger.info(
        { pageIndex, rowsOnPage: pageRows.length, cumulative: allRecordings.length },
        `Extracted rows from page ${pageIndex}`
      );

      // Check pagination and move to next page if available
      const nextBtn = await this.findNextPageButton(container);
      if (nextBtn) {
        const isDisabled = await nextBtn.isDisabled().catch(() => true);
        const ariaDisabled = await nextBtn.getAttribute('aria-disabled').catch(() => null);
        const isClickable = !isDisabled && ariaDisabled !== 'true';

        if (isClickable) {
          this.logger.info({ pageIndex }, 'Navigating to next page in Collab2 recordings table');
          const firstRowBefore = await this.getFirstRowSignature(tableLocator);

          await nextBtn.click();
          await this.waitForPageChange(tableLocator, firstRowBefore);
          pageIndex++;
        } else {
          hasMorePages = false;
        }
      } else {
        hasMorePages = false;
      }
    }

    this.logger.info(
      { totalRecordings: allRecordings.length, totalPages: pageIndex, totalVisibleRows },
      'Completed Collab2 recordings extraction'
    );

    return {
      recordings: allRecordings,
      totalPages: pageIndex,
      totalVisibleRows,
      tableDetected: true,
    };
  }

  /**
   * Searches the main page and all active iframes for the Collab2 table or grid.
   */
  public async findTableLocation(): Promise<TableLocation | null> {
    // 1. Check main page context
    const mainMatch = await this.findTableInContext(this.page);
    if (mainMatch) {
      this.logger.info('Collab2 table found in main page context');
      return { container: this.page, locator: mainMatch };
    }

    // 2. Blackboard Learn Ultra often embeds Collab2 inside an iframe (e.g. bbcollab or LTI iframe)
    const frames = this.page.frames();
    this.logger.info({ frameCount: frames.length }, 'Checking frames for Collab2 table');

    for (const frame of frames) {
      if (frame === this.page.mainFrame()) continue;

      try {
        const frameMatch = await this.findTableInContext(frame);
        if (frameMatch) {
          this.logger.info({ frameUrl: frame.url() }, 'Collab2 table found inside iframe');
          return { container: frame, locator: frameMatch };
        }
      } catch (frameErr) {
        this.logger.debug({ frameErr, frameUrl: frame.url() }, 'Error inspecting frame');
      }
    }

    return null;
  }

  /**
   * Inspects a specific context (Page or Frame) for table, role="table", role="grid" or list container.
   */
  private async findTableInContext(ctx: Page | Frame): Promise<Locator | null> {
    // Strategy A: Find by semantic table / grid with relevant headers
    const tables = ctx.locator('table, [role="table"], [role="grid"], .recordings-table, [data-testid*="recording"]');
    const count = await tables.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const candidate = tables.nth(i);
      const text = await candidate.textContent().catch(() => '');
      if (text) {
        const hasNombre = text.includes('Nombre') || text.includes('Name');
        const hasFecha = text.includes('Fecha') || text.includes('Date');
        const hasDuracion = text.includes('Duración') || text.includes('Duracion') || text.includes('Duration');
        const hasReproducir = text.includes('Reproducir') || text.includes('Play');

        if ((hasNombre && hasFecha) || (hasNombre && hasDuracion) || (hasFecha && hasReproducir)) {
          return candidate;
        }
      }
    }

    // Strategy B: If any standard table exists in an iframe that has rows
    if (count > 0) {
      const first = tables.first();
      const rowCount = await first.locator('tr, [role="row"]').count().catch(() => 0);
      if (rowCount > 0) {
        return first;
      }
    }

    return null;
  }

  /**
   * For backwards compatibility and unit tests.
   */
  public async findTableLocator(): Promise<Locator | null> {
    const loc = await this.findTableLocation();
    return loc ? loc.locator : null;
  }

  /**
   * Extracts recording items from the currently visible page of the table.
   */
  private async extractRowsFromCurrentPage(table: Locator): Promise<RecordingMetadata[]> {
    const columnMap = await this.detectColumnMapping(table);

    let rows = table.locator('tbody tr');
    let rowCount = await rows.count();

    if (rowCount === 0) {
      rows = table.locator('tr:not(:has(th)), [role="row"]:not(:has([role="columnheader"]))');
      rowCount = await rows.count();
    }

    if (rowCount === 0) {
      rows = table.locator('[role="row"], .recording-row, .row');
      rowCount = await rows.count();
    }

    const recordings: RecordingMetadata[] = [];

    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      try {
        const metadata = await this.extractRow(row, columnMap);
        if (metadata) {
          recordings.push(metadata);
        }
      } catch (err) {
        this.logger.warn({ err, rowIndex: i }, 'Error extracting single Collab2 table row, skipping');
      }
    }

    return recordings;
  }

  /**
   * Detects column headers (Nombre, Fecha de creación, Duración, Reproducir).
   */
  private async detectColumnMapping(table: Locator): Promise<{
    titleCol: number;
    dateCol: number;
    durationCol: number;
    playbackCol: number;
  }> {
    const mapping = {
      titleCol: 0,
      dateCol: 1,
      durationCol: 2,
      playbackCol: 3,
    };

    const headers = table.locator('th, [role="columnheader"]');
    const count = await headers.count();

    for (let i = 0; i < count; i++) {
      const headerText = (await headers.nth(i).textContent().catch(() => ''))?.trim().toLowerCase() ?? '';
      if (headerText.includes('nombre') || headerText.includes('name') || headerText.includes('título') || headerText.includes('titulo')) {
        mapping.titleCol = i;
      } else if (headerText.includes('fecha') || headerText.includes('date') || headerText.includes('creación') || headerText.includes('creacion')) {
        mapping.dateCol = i;
      } else if (headerText.includes('durac') || headerText.includes('duration') || headerText.includes('tiempo')) {
        mapping.durationCol = i;
      } else if (headerText.includes('reproduc') || headerText.includes('play') || headerText.includes('ver')) {
        mapping.playbackCol = i;
      }
    }

    return mapping;
  }

  /**
   * Extracts metadata from a single table row locator.
   */
  public async extractRow(
    row: Locator,
    columnMap?: { titleCol: number; dateCol: number; durationCol: number; playbackCol: number }
  ): Promise<RecordingMetadata | null> {
    const cells = row.locator('td, [role="cell"], [role="gridcell"]');
    const cellCount = await cells.count();

    let title = '';
    let dateStr = '';
    let durationStr = '';
    let playbackUrl = '';
    let uiId = '';

    const dataId = await row.getAttribute('data-id').catch(() => null);
    const dataRecordingId = await row.getAttribute('data-recording-id').catch(() => null);
    const rowId = await row.getAttribute('id').catch(() => null);
    if (dataId) uiId = dataId;
    else if (dataRecordingId) uiId = dataRecordingId;
    else if (rowId && !rowId.startsWith('ember') && !rowId.startsWith('react')) uiId = rowId;

    if (cellCount >= 3 && columnMap) {
      if (columnMap.titleCol < cellCount) {
        title = await this.getCellCleanText(cells.nth(columnMap.titleCol));
      }
      if (columnMap.dateCol < cellCount) {
        dateStr = await this.getCellCleanText(cells.nth(columnMap.dateCol));
      }
      if (columnMap.durationCol < cellCount) {
        durationStr = await this.getCellCleanText(cells.nth(columnMap.durationCol));
      }
      if (columnMap.playbackCol < cellCount) {
        const playCell = cells.nth(columnMap.playbackCol);
        playbackUrl = await this.extractPlaybackRef(playCell);
      }
    }

    if (!title) {
      const titleEl = row.locator('h1, h2, h3, h4, strong, b, [data-field="title"], a').first();
      if ((await titleEl.count()) > 0) {
        title = (await titleEl.innerText().catch(() => ''))?.trim() ?? '';
      }
    }

    if (!title && cellCount > 0) {
      title = await this.getCellCleanText(cells.first());
    }

    if (!title) {
      const fullText = await row.innerText().catch(() => '');
      title = fullText.split('\n')[0]?.trim() || '';
    }

    if (!title) {
      return null;
    }

    if (!playbackUrl) {
      playbackUrl = await this.extractPlaybackRef(row);
    }

    const createdAt = RecordingExtractor.normalizeDate(dateStr || new Date().toISOString());
    const durationSeconds = RecordingExtractor.parseDuration(durationStr);

    const collabId = RecordingExtractor.generateCollabId({
      uiId,
      playbackUrl,
      courseIdentifier: this.courseIdentifier,
      title,
      createdAt,
      durationSeconds,
    });

    return {
      collabId,
      title,
      createdAt,
      durationSeconds,
      playbackUrl,
    };
  }

  /**
   * Cleans text from Collab2 / Material-UI cells where the header name is repeated in a wrapper div.
   */
  private async getCellCleanText(cell: Locator): Promise<string> {
    const divs = cell.locator('> div, div');
    const divCount = await divs.count().catch(() => 0);
    if (divCount > 1) {
      // The last div usually contains the actual data value
      const lastText = (await divs.last().innerText().catch(() => ''))?.trim() ?? '';
      if (lastText && lastText !== 'Nombre' && lastText !== 'Fecha de creación' && lastText !== 'Duración') {
        return lastText;
      }
    }

    const raw = (await cell.innerText().catch(() => ''))?.trim() ?? '';
    // Strip leading header label if repeated (e.g. "Nombre\nTutoria...")
    return raw
      .replace(/^Nombre\s*\n?/i, '')
      .replace(/^Fecha de creación\s*\n?/i, '')
      .replace(/^Duración\s*\n?/i, '')
      .trim();
  }

  private async extractPlaybackRef(locator: Locator): Promise<string> {
    const link = locator.locator('a[href]').first();
    if ((await link.count()) > 0) {
      const href = await link.getAttribute('href').catch(() => null);
      if (href && !href.startsWith('javascript:void') && href !== '#') {
        return href;
      }
    }

    const playBtn = locator.locator('button, [role="button"], [data-action="play"], .icon-button, [aria-label="play"]').first();
    if ((await playBtn.count()) > 0) {
      const dataUrl = await playBtn.getAttribute('data-url').catch(() => null);
      if (dataUrl) return dataUrl;

      const dataHref = await playBtn.getAttribute('data-href').catch(() => null);
      if (dataHref) return dataHref;

      const titleAttr = await playBtn.getAttribute('title').catch(() => null);
      const ariaLabel = await playBtn.getAttribute('aria-label').catch(() => null);
      const btnId = await playBtn.getAttribute('id').catch(() => null);
      if (btnId) return `btn://${btnId}`;
      if (titleAttr) return `action://${encodeURIComponent(titleAttr)}`;
      if (ariaLabel) return `action://${encodeURIComponent(ariaLabel)}`;
      return 'action://play_circle';
    }

    return '';
  }

  public async findNextPageButton(ctx?: Page | Frame): Promise<Locator | null> {
    const context = ctx ?? this.page;
    const candidates = [
      'button[aria-label*="siguiente" i]',
      'button[aria-label*="next" i]',
      'a[aria-label*="siguiente" i]',
      'a[aria-label*="next" i]',
      '.pagination-next',
      '.next-page',
      '[data-testid="pagination-next"]',
      'button:has-text("Siguiente")',
      'button:has-text("Next")',
      'a:has-text("Siguiente")',
      'a:has-text("Next")',
      'button:has-text("›")',
      'button:has-text("»")',
    ];

    for (const selector of candidates) {
      const loc = context.locator(selector).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        return loc;
      }
    }

    return null;
  }

  private async getFirstRowSignature(table: Locator): Promise<string> {
    try {
      const firstRow = table.locator('tbody tr, tr').first();
      if ((await firstRow.count()) > 0) {
        return (await firstRow.innerText().catch(() => ''))?.trim() ?? '';
      }
    } catch {}
    return '';
  }

  private async waitForPageChange(table: Locator, previousSignature: string): Promise<void> {
    try {
      const startTime = Date.now();
      while (Date.now() - startTime < 5000) {
        const currentSig = await this.getFirstRowSignature(table);
        if (currentSig && currentSig !== previousSignature) {
          return;
        }
        await this.page.waitForTimeout(200);
      }
    } catch {
      await this.page.waitForTimeout(500);
    }
  }

  public static parseDuration(durationStr: string): number {
    if (!durationStr) return 0;
    const s = durationStr.trim().toLowerCase();

    if (s.includes(':')) {
      const parts = s.split(':').map(p => parseInt(p.trim(), 10));
      if (parts.length === 3 && !parts.some(isNaN)) {
        return (parts[0]! * 3600) + (parts[1]! * 60) + parts[2]!;
      } else if (parts.length === 2 && !parts.some(isNaN)) {
        return (parts[0]! * 60) + parts[1]!;
      }
    }

    let totalSeconds = 0;
    const hMatch = s.match(/(\d+)\s*(?:h|hora|horas|hour|hours)/);
    if (hMatch && hMatch[1]) totalSeconds += parseInt(hMatch[1], 10) * 3600;

    const mMatch = s.match(/(\d+)\s*(?:m|min|minuto|minutos|minute|minutes)/);
    if (mMatch && mMatch[1]) totalSeconds += parseInt(mMatch[1], 10) * 60;

    const sMatch = s.match(/(\d+)\s*(?:s|seg|segundo|segundos|sec|secs|second|seconds)/);
    if (sMatch && sMatch[1]) totalSeconds += parseInt(sMatch[1], 10);

    if (totalSeconds > 0) return totalSeconds;

    const num = parseInt(s, 10);
    if (!isNaN(num)) return num * 60;

    return 0;
  }

  public static normalizeDate(dateStr: string): string {
    if (!dateStr) return new Date().toISOString();

    const s = dateStr.trim();
    const lower = s.toLowerCase();

    if (lower === 'today' || lower === 'hoy') {
      return new Date().toISOString();
    }

    if (lower === 'yesterday' || lower === 'ayer') {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString();
    }

    const dmyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (dmyMatch && dmyMatch[1] && dmyMatch[2] && dmyMatch[3]) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10) - 1;
      const year = parseInt(dmyMatch[3], 10);
      const hour = dmyMatch[4] ? parseInt(dmyMatch[4], 10) : 0;
      const minute = dmyMatch[5] ? parseInt(dmyMatch[5], 10) : 0;
      const second = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;

      const dateObj = new Date(year, month, day, hour, minute, second);
      if (!isNaN(dateObj.getTime())) {
        return dateObj.toISOString();
      }
    }

    const spanishMonths: Record<string, number> = {
      enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
      julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11
    };
    const spanishTextMatch = lower.match(/^(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
    if (spanishTextMatch && spanishTextMatch[1] && spanishTextMatch[2] && spanishTextMatch[3]) {
      const day = parseInt(spanishTextMatch[1], 10);
      const monthName = spanishTextMatch[2];
      const year = parseInt(spanishTextMatch[3], 10);
      if (spanishMonths[monthName] !== undefined) {
        const dateObj = new Date(year, spanishMonths[monthName]!, day);
        if (!isNaN(dateObj.getTime())) {
          return dateObj.toISOString();
        }
      }
    }

    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }

    return new Date().toISOString();
  }

  public static generateCollabId(params: {
    uiId?: string;
    playbackUrl?: string;
    courseIdentifier?: string;
    title: string;
    createdAt: string;
    durationSeconds: number;
  }): string {
    const { uiId, playbackUrl, courseIdentifier = 'default-course', title, createdAt, durationSeconds } = params;

    if (uiId && uiId.trim().length > 0) {
      return crypto.createHash('sha256').update(`ui:${uiId.trim()}`).digest('hex').substring(0, 16);
    }

    if (playbackUrl && playbackUrl.startsWith('http')) {
      return crypto.createHash('sha256').update(`url:${playbackUrl.trim()}`).digest('hex').substring(0, 16);
    }

    const compound = `${courseIdentifier}|${title.trim()}|${createdAt.trim()}|${durationSeconds}`;
    return crypto.createHash('sha256').update(`compound:${compound}`).digest('hex').substring(0, 16);
  }
}
