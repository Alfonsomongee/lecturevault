/**
 * Player Inspector — Milestone 2 (Read-Only)
 *
 * Inspects official visible playback, subtitle, transcript, and download
 * capabilities in the Collab2 / Blackboard Collaborate playback UI.
 *
 * STRICT SAFETY RULES:
 * - Read-only: never clicks Play, Pause, CC, Download, or menu options
 * - Never inspects, saves, or reconstructs media streams
 * - Never searches for HLS/DASH/m3u8/mpd/ts/m4s URLs
 * - Never reads, stores, or logs cookies, tokens, or private playback URLs
 */

import type { Page, Frame, Locator, BrowserContext } from 'playwright';
import type { Logger } from 'pino';
import type { PlayerCapabilities, PlayerInspectionReport } from '../types.js';
import type { DiagnosticsManager } from '../utils/diagnostics.js';

export interface PlayerInspectorOptions {
  diagnostics?: DiagnosticsManager;
  allowedHosts: string[];
}

export class PlayerInspector {
  private page: Page;
  private context: BrowserContext;
  private logger: Logger;
  private options: PlayerInspectorOptions;

  constructor(page: Page, context: BrowserContext, logger: Logger, options: PlayerInspectorOptions) {
    this.page = page;
    this.context = context;
    this.logger = logger.child({ component: 'player-inspector' });
    this.options = options;
  }

  /**
   * Main inspection flow:
   * 1. Detect which active page/tab/popup displays the player
   * 2. Validate current host against explicit allowlist
   * 3. Inspect visible controls & accessibility labels across main page and iframes
   * 4. Save sanitized diagnostic report
   */
  public async inspectPlayer(): Promise<PlayerInspectionReport> {
    const warnings: string[] = [];
    const timestamp = new Date().toISOString();

    // 1. Identify active page/tab containing the player
    const { activePage, windowContext } = await this.resolveActivePlayerPage();

    // 2. Validate host
    const currentUrl = activePage.url();
    let sanitizedHost = '';
    try {
      sanitizedHost = new URL(currentUrl).hostname.toLowerCase();
    } catch {
      sanitizedHost = 'unknown-host';
    }

    this.logger.info({ sanitizedHost, windowContext }, 'Identified playback page host and window context');

    const isHostAllowed = this.options.allowedHosts
      .map(h => h.toLowerCase())
      .includes(sanitizedHost);

    if (!isHostAllowed) {
      const err = `Current playback host "${sanitizedHost}" is not in the explicit allowlist. Inspection aborted for security.`;
      this.logger.error(err);
      warnings.push(err);
      return {
        timestamp,
        capabilities: this.createEmptyCapabilities(sanitizedHost, windowContext),
        warnings,
      };
    }

    // 3. Search for player container across main page and frames
    const playerContext = await this.findPlayerContainer(activePage);

    if (!playerContext) {
      this.logger.warn('No active player container detected on page');
      return {
        timestamp,
        capabilities: this.createEmptyCapabilities(sanitizedHost, windowContext),
        warnings: ['Player container was not detected on page'],
      };
    }

    const { container, isEmbeddedInIframe, controlRoot } = playerContext;
    this.logger.info({ isEmbeddedInIframe }, 'Player container successfully located');

    // 4. Inspect visible & accessibility-exposed controls WITHOUT clicking them
    const capabilities = await this.extractCapabilities(container, controlRoot, sanitizedHost, windowContext, isEmbeddedInIframe);

    // 5. Diagnostics (if enabled): capture smallest control container and safe screenshot
    let diagnosticFilePath: string | undefined;
    let screenshotPath: string | undefined;

    if (this.options.diagnostics) {
      const diagFile = await this.options.diagnostics.captureSanitizedPlayerContainer(
        activePage,
        controlRoot,
        'player-controls'
      );
      if (diagFile) diagnosticFilePath = diagFile;

      const screenFile = await this.options.diagnostics.captureSafeScreenshot(activePage, 'player-inspection');
      if (screenFile) screenshotPath = screenFile;
    }

    return {
      timestamp,
      capabilities,
      diagnosticFilePath,
      screenshotPath,
      warnings,
    };
  }

  /**
   * Checks whether the player is in the initial page, a new tab, or a popup.
   */
  public async resolveActivePlayerPage(): Promise<{ activePage: Page; windowContext: 'same-tab' | 'new-tab' | 'popup' }> {
    const pages = this.context.pages();

    if (pages.length === 1) {
      return { activePage: this.page, windowContext: 'same-tab' };
    }

    // Multiple pages: find the one that has player-like URLs or content
    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i]!;
      const url = p.url().toLowerCase();
      if (url.includes('playback') || url.includes('session') || url.includes('collab') || url.includes('player')) {
        return { activePage: p, windowContext: 'new-tab' };
      }
    }

    // Default to the most recently opened page
    const lastPage = pages[pages.length - 1]!;
    return { activePage: lastPage, windowContext: 'new-tab' };
  }

  /**
   * Finds the player container and its controls across the page and iframes.
   */
  private async findPlayerContainer(page: Page): Promise<{
    container: Page | Frame;
    controlRoot: Locator;
    isEmbeddedInIframe: boolean;
  } | null> {
    // 1. Check main page
    const mainRoot = await this.findPlayerRootInContext(page);
    if (mainRoot) {
      return { container: page, controlRoot: mainRoot, isEmbeddedInIframe: false };
    }

    // 2. Check iframes
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameRoot = await this.findPlayerRootInContext(frame);
        if (frameRoot) {
          return { container: frame, controlRoot: frameRoot, isEmbeddedInIframe: true };
        }
      } catch {}
    }

    return null;
  }

  /**
   * Evaluates if a given Page or Frame contains a recognized playback container.
   */
  private async findPlayerRootInContext(ctx: Page | Frame): Promise<Locator | null> {
    const candidateSelectors = [
      '.playback-container',
      '.player-container',
      '.video-player',
      '[role="region"][aria-label*="player" i]',
      '[role="region"][aria-label*="reproductor" i]',
      '.vjs-tech',
      '.vjs-control-bar',
      '.jwplayer',
      '.bb-recording-playback',
      'video',
      'audio',
      '[data-testid*="playback"]',
      '[data-testid*="player"]',
      '#player',
      '.controls-bar',
      '.playback-controls',
    ];

    for (const sel of candidateSelectors) {
      const loc = ctx.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        // Return surrounding container if possible, else the element itself
        const parent = loc.locator('xpath=..');
        return (await parent.count().catch(() => 0)) > 0 ? parent : loc;
      }
    }

    return null;
  }

  /**
   * Inspects accessibility roles, aria attributes, buttons, and text labels.
   * STRICT: NEVER clicks any button.
   */
  private async extractCapabilities(
    ctx: Page | Frame,
    root: Locator,
    sanitizedHost: string,
    windowContext: 'same-tab' | 'new-tab' | 'popup',
    isEmbeddedInIframe: boolean
  ): Promise<PlayerCapabilities> {
    const accessibilityLabels: string[] = [];

    // Search context for all buttons, menus, and controls in the player
    const controlScope = (await root.count()) > 0 ? root : ctx.locator('body');

    // 1. Play / Pause Control
    const playPauseLoc = controlScope.locator(
      'button[aria-label*="play" i], button[aria-label*="pause" i], button[aria-label*="reproducir" i], button[aria-label*="pausar" i], button.vjs-play-control, button.play-button, .play-pause-btn'
    );
    const hasPlayPauseControl = (await playPauseLoc.count().catch(() => 0)) > 0;
    if (hasPlayPauseControl) {
      const label = (await playPauseLoc.first().getAttribute('aria-label').catch(() => null)) ?? 'Play/Pause';
      accessibilityLabels.push(`Play/Pause: "${label}"`);
    }

    // Check if user interaction is required to play (e.g. paused on load or has big play button)
    const bigPlayBtn = controlScope.locator('.vjs-big-play-button, button[title*="reproducir" i], .big-play-btn');
    const requiresUserInteractionToPlay = (await bigPlayBtn.count().catch(() => 0)) > 0 || hasPlayPauseControl;

    // 2. Duration and Current Time
    let hasTimeDisplay = false;
    let visibleDurationText: string | undefined;
    let visibleCurrentTimeText: string | undefined;

    const timeLoc = controlScope.locator(
      '.vjs-time-control, .vjs-duration, .vjs-current-time, .duration-display, .time-display, [aria-label*="duración" i], [aria-label*="duration" i]'
    );
    if ((await timeLoc.count().catch(() => 0)) > 0) {
      hasTimeDisplay = true;
      const allText = (await timeLoc.allInnerTexts().catch(() => [])) || [];
      const combined = allText.join(' ');
      const matchTimes = combined.match(/(\d{1,2}:\d{2}(?::\d{2})?)/g);
      if (matchTimes && matchTimes.length >= 2) {
        visibleCurrentTimeText = matchTimes[0];
        visibleDurationText = matchTimes[1];
      } else if (matchTimes && matchTimes.length === 1) {
        visibleDurationText = matchTimes[0];
      }
    } else {
      // Look for text matching clock pattern inside control scope
      const clockMatch = (await controlScope.innerText().catch(() => '')).match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*[\/|\-]\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (clockMatch && clockMatch[1] && clockMatch[2]) {
        hasTimeDisplay = true;
        visibleCurrentTimeText = clockMatch[1];
        visibleDurationText = clockMatch[2];
      }
    }

    // 3. Playback speed control
    const speedLoc = controlScope.locator(
      'button[aria-label*="velocidad" i], button[aria-label*="speed" i], .vjs-playback-rate, [title*="velocidad" i], [title*="speed" i], button:has-text("1x"), button:has-text("1.0x")'
    );
    const hasPlaybackSpeedControl = (await speedLoc.count().catch(() => 0)) > 0;
    if (hasPlaybackSpeedControl) {
      accessibilityLabels.push('Playback-Speed Control');
    }

    // 4. Closed Captions (CC) / Subtitles
    const ccLoc = controlScope.locator(
      'button[aria-label*="subtítulo" i], button[aria-label*="subtitulo" i], button[aria-label*="caption" i], button[aria-label*="subtitle" i], .vjs-subs-caps-button, .vjs-captions-button, button:has-text("CC")'
    );
    const hasClosedCaptionsControl = (await ccLoc.count().catch(() => 0)) > 0;
    if (hasClosedCaptionsControl) {
      const label = (await ccLoc.first().getAttribute('aria-label').catch(() => null)) ?? 'CC/Subtitles';
      accessibilityLabels.push(`Subtitles: "${label}"`);
    }

    // 5. Transcript panel or button
    const transcriptLoc = controlScope.locator(
      'button[aria-label*="transcrip" i], a[aria-label*="transcrip" i], [role="tab"]:has-text("Transcrip"), button:has-text("Transcrip"), [data-testid*="transcript"]'
    );
    const hasTranscriptPanelOrButton = (await transcriptLoc.count().catch(() => 0)) > 0;
    if (hasTranscriptPanelOrButton) {
      accessibilityLabels.push('Transcript Panel/Button');
    }

    // 6. Download Option (Check menu items, buttons, or direct visible options)
    let hasDownloadOption = false;
    let downloadLabelOrType: string | undefined;

    const downloadLoc = controlScope.locator(
      'button[aria-label*="descarg" i], button[aria-label*="download" i], a[aria-label*="descarg" i], a[aria-label*="download" i], [title*="descarg" i], [title*="download" i], button:has-text("Descargar"), a:has-text("Descargar")'
    );
    if ((await downloadLoc.count().catch(() => 0)) > 0) {
      hasDownloadOption = true;
      downloadLabelOrType = (await downloadLoc.first().innerText().catch(() => '')) ||
                            (await downloadLoc.first().getAttribute('aria-label').catch(() => '')) ||
                            'Download';
      accessibilityLabels.push(`Download option: "${downloadLabelOrType}"`);
    }

    // Also inspect Collaborate recording side menu (three bars / kebab icon)
    const sideMenuLoc = controlScope.locator(
      'button[aria-label*="menú" i], button[aria-label*="menu" i], button#recording-menu-btn, .recording-menu-button, button.side-menu-btn'
    );
    if ((await sideMenuLoc.count().catch(() => 0)) > 0) {
      accessibilityLabels.push('Recording Session Menu (3-dots / hamburger)');
    }

    // 7. Chat or Session Content Options
    const chatLoc = controlScope.locator(
      'button[aria-label*="chat" i], [role="tab"]:has-text("Chat"), button:has-text("Chat"), button[aria-label*="contenido" i], [role="tab"]:has-text("Contenido")'
    );
    const hasChatOrSessionContentOption = (await chatLoc.count().catch(() => 0)) > 0;
    if (hasChatOrSessionContentOption) {
      accessibilityLabels.push('Chat / Session Content Panel');
    }

    return {
      sanitizedHost,
      windowContext,
      playerDetected: true,
      isEmbeddedInIframe,
      requiresUserInteractionToPlay,
      hasPlayPauseControl,
      hasTimeDisplay,
      visibleDurationText,
      visibleCurrentTimeText,
      hasPlaybackSpeedControl,
      hasClosedCaptionsControl,
      subtitleStatus: 'No subtitle track was detected as loaded at inspection time.',
      hasTranscriptPanelOrButton,
      hasDownloadOption,
      downloadLabelOrType,
      hasChatOrSessionContentOption,
      accessibilityLabels,
    };
  }

  private createEmptyCapabilities(sanitizedHost: string, windowContext: 'same-tab' | 'new-tab' | 'popup'): PlayerCapabilities {
    return {
      sanitizedHost,
      windowContext,
      playerDetected: false,
      isEmbeddedInIframe: false,
      requiresUserInteractionToPlay: false,
      hasPlayPauseControl: false,
      hasTimeDisplay: false,
      hasPlaybackSpeedControl: false,
      hasClosedCaptionsControl: false,
      subtitleStatus: 'No subtitle track was detected as loaded at inspection time.',
      hasTranscriptPanelOrButton: false,
      hasDownloadOption: false,
      hasChatOrSessionContentOption: false,
      accessibilityLabels: [],
    };
  }
}
