import { test, expect } from '@playwright/test';
import { PlayerInspector } from '../../src/browser/PlayerInspector.js';
import pino from 'pino';

test.describe('PlayerInspector Milestone 2 (Read-Only Synthetic Tests)', () => {
  const silentLogger = pino({ level: 'silent' });

  test('detects visible playback capabilities on synthetic Collaborate UI fixture', async ({ page, context }) => {
    // Inject a synthetic mock Collaborate / VideoJS-like playback DOM
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Blackboard Collaborate Playback</title></head>
        <body>
          <div class="playback-container">
            <div class="video-player">
              <video id="player-video"></video>
              <div class="vjs-control-bar controls-bar">
                <!-- Play / Pause -->
                <button class="vjs-play-control play-button" aria-label="Reproducir grabación" title="Reproducir">
                  <span>Play</span>
                </button>
                <!-- Current Time & Duration -->
                <div class="vjs-time-control duration-display">
                  <span class="vjs-current-time-display">00:15:30</span> / <span class="vjs-duration-display">01:30:00</span>
                </div>
                <!-- Playback Rate / Speed -->
                <button class="vjs-playback-rate" aria-label="Velocidad de reproducción" title="Velocidad">
                  <span>1x</span>
                </button>
                <!-- Subtitles / CC -->
                <button class="vjs-subs-caps-button" aria-label="Subtítulos disponibles" title="Subtítulos">
                  <span>CC</span>
                </button>
                <!-- Transcript Tab -->
                <button aria-label="Ver transcripción" title="Transcripción">
                  <span>Transcripción</span>
                </button>
                <!-- Recording Side Menu / Download option -->
                <button id="recording-menu-btn" aria-label="Menú de grabación" title="Menú">
                  <span>Menu</span>
                </button>
                <div class="recording-menu-items">
                  <button aria-label="Descargar grabación" title="Descargar">
                    <span>Descargar grabación</span>
                  </button>
                </div>
                <!-- Chat Panel -->
                <button aria-label="Abrir panel de chat" title="Chat">
                  <span>Chat</span>
                </button>
              </div>
            </div>
          </div>
        </body>
      </html>
    `);

    const host = new URL(page.url()).hostname.toLowerCase();
    const inspector = new PlayerInspector(page, context, silentLogger, {
      allowedHosts: [host, 'localhost', 'eu.bbcollab.com'],
    });

    const report = await inspector.inspectPlayer();
    const caps = report.capabilities;

    expect(caps.playerDetected).toBe(true);
    expect(caps.hasPlayPauseControl).toBe(true);
    expect(caps.hasTimeDisplay).toBe(true);
    expect(caps.visibleDurationText).toBe('01:30:00');
    expect(caps.visibleCurrentTimeText).toBe('00:15:30');
    expect(caps.hasPlaybackSpeedControl).toBe(true);
    expect(caps.hasClosedCaptionsControl).toBe(true);
    expect(caps.hasTranscriptPanelOrButton).toBe(true);
    expect(caps.hasDownloadOption).toBe(true);
    expect(caps.hasChatOrSessionContentOption).toBe(true);
    expect(caps.isEmbeddedInIframe).toBe(false);
    expect(caps.requiresUserInteractionToPlay).toBe(true);
  });

  test('strictly rejects inspection if player page host is outside explicit allowlist', async ({ page, context }) => {
    await page.goto('data:text/html,<html><body><div class="video-player"><button>Play</button></div></body></html>');

    const inspector = new PlayerInspector(page, context, silentLogger, {
      allowedHosts: ['eu.bbcollab.com'], // Does not include data: or unknown hosts
    });

    const report = await inspector.inspectPlayer();
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings[0]).toContain('is not in the explicit allowlist');
    expect(report.capabilities.playerDetected).toBe(false);
  });

  test('inspects player embedded inside an iframe fixture', async ({ page, context }) => {
    // Inject page with an embedded iframe
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Blackboard LTI Container</title></head>
        <body>
          <iframe id="collab-frame" srcdoc="
            <div class='playback-container'>
              <button aria-label='Reproducir'>Play</button>
              <div class='time-display'>00:00 / 45:00</div>
              <button aria-label='Subtítulos'>CC</button>
            </div>
          "></iframe>
        </body>
      </html>
    `);

    // Allow host
    const currentHost = new URL(page.url()).hostname.toLowerCase();
    const inspector = new PlayerInspector(page, context, silentLogger, {
      allowedHosts: [currentHost],
    });

    const report = await inspector.inspectPlayer();
    const caps = report.capabilities;

    expect(caps.playerDetected).toBe(true);
    expect(caps.isEmbeddedInIframe).toBe(true);
    expect(caps.hasPlayPauseControl).toBe(true);
    expect(caps.hasClosedCaptionsControl).toBe(true);
    expect(caps.hasTimeDisplay).toBe(true);
  });
});
