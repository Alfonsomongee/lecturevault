import { test, expect } from '@playwright/test';
import { AudioCaptureManager } from '../../src/capture/AudioCaptureManager.js';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

test.describe('AudioCaptureManager E2E Tests (In-Browser Capture)', () => {
  const silentLogger = pino({ level: 'silent' });

  test('captures audio from an HTML5 media element and generates 16kHz mono WAV', async ({ page, context }) => {
    // Inject synthetic media page with WebAudio tone feeding a video element
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Synthetic Audio Player</title></head>
        <body>
          <div class="playback-container">
            <video id="test-video" autoplay playsinline></video>
          </div>
          <script>
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = audioCtx.createOscillator();
            osc.frequency.setValueAtTime(440, audioCtx.currentTime);
            const dest = audioCtx.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();

            const v = document.getElementById('test-video');
            v.srcObject = dest.stream;
            v.play();
          </script>
        </body>
      </html>
    `);

    const outputDir = path.resolve('data/audio');
    const manager = new AudioCaptureManager(page, context, silentLogger, {
      outputDir,
      allowedHosts: ['localhost'],
    });

    // 1. Inject Hook
    const hookResult = await manager.injectCaptureHook(page);
    expect(hookResult.found).toBe(true);

    // 2. Start Capture
    await manager.startCapture(hookResult.frame);

    // 3. Record for 1.5 seconds
    await page.waitForTimeout(1500);

    // 4. Stop Capture
    const testId = `e2e-test-${Date.now()}`;
    const result = await manager.stopCapture(hookResult.frame, testId);

    expect(result.recordingId).toBe(testId);
    expect(result.wavPath).toContain(`${testId}.wav`);
    expect(fs.existsSync(result.wavPath)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(1000);

    // Cleanup generated test wav
    try {
      fs.unlinkSync(result.wavPath);
    } catch {}
  });
});
