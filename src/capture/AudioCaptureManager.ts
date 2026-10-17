/**
 * Audio Capture Manager — Milestone 3 & 4 Pipeline Integration
 *
 * In-browser digital audio capturing for Blackboard Collaborate / HTML5 players:
 * - Aislado al proceso del navegador (cero acceso a micrófonos).
 * - Utiliza MediaRecorder sobre video.captureStream() o Web Audio.
 * - Normaliza automáticamente a WAV 16 kHz Mono PCM mediante FFmpeg.
 * - Invoca el motor de transcripción local faster-whisper.
 */

import type { Page, BrowserContext, Frame } from 'playwright';
import type { Logger } from 'pino';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { sanitizeRecordingId } from '../utils/ids.js';

export interface AudioCaptureOptions {
  outputDir?: string;
  allowedHosts?: string[];
}

export interface PlaybackProgress {
  hasMedia: boolean;
  currentTime: number;
  duration: number;
  isPaused: boolean;
  hasEnded: boolean;
  percentage: number;
  playbackRate?: number;
}

/**
 * Builds FFmpeg audio filter chain using atempo to restore audio to 1x speed.
 */
export function buildAtempoFilter(speed: number): string | null {
  if (speed <= 0 || Math.abs(speed - 1.0) < 0.01) return null;
  const factor = 1 / speed;
  const filters: string[] = [];
  let remaining = factor;

  while (remaining < 0.4999) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  while (remaining > 2.0001) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  if (Math.abs(remaining - 1.0) > 0.005) {
    let formatted: string;
    if (Math.abs(remaining - 0.5) < 0.001) formatted = '0.5';
    else if (Math.abs(remaining - 2.0) < 0.001) formatted = '2.0';
    else formatted = remaining.toFixed(4);
    filters.push(`atempo=${formatted}`);
  }
  return filters.join(',');
}

export interface CaptureResult {
  recordingId: string;
  wavPath: string;
  rawWebmPath?: string;
  audioDurationSeconds?: number;
  videoDurationSeconds?: number;
  sizeBytes: number;
}

export class AudioCaptureManager {
  private page: Page;
  private context: BrowserContext;
  private logger: Logger;
  private outputDir: string;
  private allowedHosts: string[];

  constructor(
    page: Page,
    context: BrowserContext,
    logger: Logger,
    options?: AudioCaptureOptions
  ) {
    this.page = page;
    this.context = context;
    this.logger = logger.child({ component: 'audio-capture-manager' });
    this.outputDir = options?.outputDir
      ? path.resolve(options.outputDir)
      : path.resolve('data', 'audio');
    this.allowedHosts = (options?.allowedHosts || []).map((h) => h.toLowerCase());

    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Validates if a host or URL is in the allowed hosts list.
   */
  public isHostAllowed(urlOrHost: string): boolean {
    if (this.allowedHosts.length === 0) return true;
    let host = urlOrHost;
    try {
      host = new URL(urlOrHost).hostname;
    } catch {}
    return this.allowedHosts.includes(host.toLowerCase());
  }

  /**
   * Sanitizes recording ID to prevent directory traversal.
   */
  public sanitizeRecordingId(id: string): string {
    return sanitizeRecordingId(id);
  }

  /**
   * Identifies the active page containing the media player.
   */
  public async findActivePlayerPage(): Promise<Page> {
    const pages = this.context.pages();
    if (pages.length === 0) return this.page;
    if (pages.length === 1) return pages[0] || this.page;

    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i]!;
      const url = p.url().toLowerCase();
      if (
        url.includes('playback') ||
        url.includes('session') ||
        url.includes('collab') ||
        url.includes('player')
      ) {
        return p;
      }
    }

    return pages[pages.length - 1] || this.page;
  }

  /**
   * Injects the MediaRecorder audio capture hook into the page/frame holding the video element.
   */
  public async injectCaptureHook(targetPage: Page): Promise<{ frame: Page | Frame; found: boolean }> {
    this.logger.info('Searching for media element across main frame and iframes...');

    const targets: (Page | Frame)[] = [targetPage, ...targetPage.frames().filter(f => f !== targetPage.mainFrame())];

    for (const ctx of targets) {
      try {
        const hasMedia = await ctx.evaluate(() => {
          const el = document.querySelector('video') || document.querySelector('audio');
          return el !== null;
        });

        if (hasMedia) {
          this.logger.info('Media element detected, injecting in-page audio recorder...');
          await ctx.evaluate(() => {
            (window as any).__LV_RECORDER__ = {
              mediaRecorder: null,
              chunks: [],
              stream: null,
              isRecording: false,
              mediaEl: null,
              hasEnded: false,

              async start(speed = 1.0) {
                const el = document.querySelector('video') || document.querySelector('audio');
                if (!el) throw new Error('No video or audio element found to record');
                this.mediaEl = el;

                // Ensure media is not muted
                if (el.muted) el.muted = false;
                if (el.volume === 0) el.volume = 1.0;

                // Set playback rate acceleration if requested
                if (typeof speed === 'number' && speed > 0) {
                  try {
                    el.playbackRate = speed;
                  } catch (_) {}
                }

                // Listen for ended event on the media element
                this.hasEnded = false;
                el.addEventListener('ended', () => {
                  if (el.duration > 0 && el.currentTime >= el.duration - 2) {
                    this.hasEnded = true;
                  }
                });

                let mediaStream: MediaStream | null = null;
                if (typeof (el as any).captureStream === 'function') {
                  mediaStream = (el as any).captureStream();
                } else if (typeof (el as any).mozCaptureStream === 'function') {
                  mediaStream = (el as any).mozCaptureStream();
                }

                if (!mediaStream || mediaStream.getAudioTracks().length === 0) {
                  // Fallback: WebAudio destination
                  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
                  if (AudioCtx) {
                    const actx = new AudioCtx();
                    const source = actx.createMediaElementSource(el);
                    const dest = actx.createMediaStreamDestination();
                    source.connect(dest);
                    source.connect(actx.destination);
                    mediaStream = dest.stream;
                  }
                }

                if (!mediaStream) {
                  throw new Error('Unable to create MediaStream from player element');
                }

                const audioTracks = mediaStream.getAudioTracks();
                if (audioTracks.length === 0) {
                  throw new Error('No audio tracks found in media element stream');
                }

                this.stream = new MediaStream(audioTracks);
                this.chunks = [];

                let mime = 'audio/webm';
                if (!MediaRecorder.isTypeSupported('audio/webm')) {
                  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
                }

                this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: mime });
                this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
                  if (e.data && e.data.size > 0) {
                    this.chunks.push(e.data);
                  }
                };

                this.mediaRecorder.start(1000); // 1-second timeslice
                this.isRecording = true;

                // Auto-play if paused
                if (el.paused) {
                  try {
                    await el.play();
                  } catch (_) {}
                }

                return true;
              },

              getPlaybackProgress() {
                const el = this.mediaEl || document.querySelector('video') || document.querySelector('audio');
                if (!el) {
                  return {
                    hasMedia: false,
                    currentTime: 0,
                    duration: 0,
                    isPaused: true,
                    hasEnded: false,
                    percentage: 0,
                  };
                }

                const cur = el.currentTime || 0;
                const dur = el.duration || 0;
                const ended = this.hasEnded || el.ended || (dur > 0 && cur >= dur - 0.5);

                return {
                  hasMedia: true,
                  currentTime: Math.round(cur * 10) / 10,
                  duration: Math.round(dur * 10) / 10,
                  isPaused: el.paused,
                  hasEnded: ended,
                  percentage: dur > 0 ? Math.min(100, Math.round((cur / dur) * 100)) : 0,
                  playbackRate: el.playbackRate || 1.0,
                };
              },

              async stop(): Promise<string> {
                if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
                  throw new Error('Recorder is not active');
                }

                // Flush pending audio chunks to prevent loss of trailing audio
                if (this.mediaRecorder.state === 'recording') {
                  try {
                    this.mediaRecorder.requestData();
                  } catch (_) {}
                }

                return new Promise((resolve, reject) => {
                  this.mediaRecorder.onstop = () => {
                    try {
                      const blob = new Blob(this.chunks, { type: 'audio/webm' });
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        const base64 = (reader.result as string).split(',')[1];
                        resolve(base64 || '');
                      };
                      reader.onerror = reject;
                      reader.readAsDataURL(blob);
                    } catch (err) {
                      reject(err);
                    }
                  };
                  this.mediaRecorder.stop();
                  this.isRecording = false;
                });
              },

              getStatus() {
                return {
                  isRecording: this.isRecording,
                  chunks: this.chunks.length,
                  state: this.mediaRecorder ? this.mediaRecorder.state : 'uninitialized'
                };
              }
            };
          });

          return { frame: ctx, found: true };
        }
      } catch (err) {
        this.logger.debug({ err }, 'Error inspecting frame for media element');
      }
    }

    return { frame: targetPage, found: false };
  }

  /**
   * Retrieves current playback progress (currentTime, duration, isPaused, hasEnded).
   */
  public async getPlaybackProgress(targetContext: Page | Frame): Promise<PlaybackProgress> {
    return await targetContext.evaluate(() => {
      const rec = (window as any).__LV_RECORDER__;
      if (rec && typeof rec.getPlaybackProgress === 'function') {
        return rec.getPlaybackProgress();
      }
      const el = document.querySelector('video') || document.querySelector('audio');
      if (!el) {
        return {
          hasMedia: false,
          currentTime: 0,
          duration: 0,
          isPaused: true,
          hasEnded: false,
          percentage: 0,
        };
      }
      const cur = el.currentTime || 0;
      const dur = el.duration || 0;
      const ended = el.ended || (dur > 0 && cur >= dur - 0.5);
      return {
        hasMedia: true,
        currentTime: Math.round(cur * 10) / 10,
        duration: Math.round(dur * 10) / 10,
        isPaused: el.paused,
        hasEnded: ended,
        percentage: dur > 0 ? Math.min(100, Math.round((cur / dur) * 100)) : 0,
      };
    });
  }

  /**
   * Starts recording audio from the player in the active page with optional playback speed acceleration.
   */
  public async startCapture(targetContext: Page | Frame, speed: number = 1.0): Promise<void> {
    this.logger.info({ speed }, 'Starting audio capture on media element...');
    await targetContext.evaluate(async (sp) => {
      const rec = (window as any).__LV_RECORDER__;
      if (!rec) throw new Error('Audio recorder hook not injected in page');
      await rec.start(sp);
    }, speed);
    this.logger.info({ speed }, 'In-browser audio capture started successfully');
  }

  /**
   * Stops recording audio and saves the captured data, restoring speed via FFmpeg if accelerated.
   */
  public async stopCapture(
    targetContext: Page | Frame,
    recordingIdRaw: string,
    speed: number = 1.0
  ): Promise<CaptureResult> {
    const recordingId = this.sanitizeRecordingId(recordingIdRaw);
    this.logger.info({ recordingId, speed }, 'Stopping audio capture...');

    // Query video duration before stopping
    const progress = await this.getPlaybackProgress(targetContext).catch(() => null);
    const videoDurationSeconds = progress?.duration && progress.duration > 0 ? progress.duration : undefined;

    const base64Data: string = await targetContext.evaluate(async () => {
      const rec = (window as any).__LV_RECORDER__;
      if (!rec) throw new Error('Audio recorder hook not injected in page');
      return await rec.stop();
    });

    if (!base64Data || base64Data.length === 0) {
      throw new Error('Captured audio buffer is empty. Ensure playback was active during capture.');
    }

    const rawWebmPath = path.join(this.outputDir, `raw-${recordingId}.webm`);
    const targetWavPath = path.join(this.outputDir, `${recordingId}.wav`);

    const audioBuffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(rawWebmPath, audioBuffer);
    this.logger.info({ rawWebmPath, bytes: audioBuffer.length }, 'Raw WebM audio saved');

    // Convert to normalized 16 kHz Mono WAV using FFmpeg, restoring speed if accelerated
    this.logger.info({ targetWavPath, speed }, 'Normalizing to 16 kHz mono WAV via FFmpeg (restoring speed)...');
    await this.convertWebmTo16kHzMonoWav(rawWebmPath, targetWavPath, speed);

    const stats = fs.statSync(targetWavPath);
    // 16 kHz 16-bit mono = 32000 bytes per second, 44-byte WAV header
    const audioDurationSeconds = Math.max(0, Math.round(((stats.size - 44) / 32000) * 10) / 10);
    this.logger.info(
      { targetWavPath, sizeBytes: stats.size, audioDurationSeconds, videoDurationSeconds },
      'Normalized WAV audio ready'
    );

    // Safety verification: check if audio duration significantly lags video duration
    if (videoDurationSeconds && audioDurationSeconds < videoDurationSeconds - 5) {
      this.logger.warn(
        { audioDurationSeconds, videoDurationSeconds },
        'Aviso: La duración del audio capturado es menor que la duración del vídeo. Posible corte previo o buffering.'
      );
    }

    // Remove intermediate raw WebM
    try {
      fs.unlinkSync(rawWebmPath);
    } catch {}

    return {
      recordingId,
      wavPath: targetWavPath,
      audioDurationSeconds,
      videoDurationSeconds,
      sizeBytes: stats.size,
    };
  }

  /**
   * Converts a WebM file to 16 kHz Mono PCM WAV using system FFmpeg, applying atempo filter if accelerated.
   */
  public async convertWebmTo16kHzMonoWav(
    inputPath: string,
    outputPath: string,
    speed: number = 1.0
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const atempo = buildAtempoFilter(speed);
      const args = [
        '-y',
        '-i', inputPath,
        ...(atempo ? ['-filter:a', atempo] : []),
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        outputPath
      ];

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start FFmpeg: ${err.message}`));
      });
    });
  }
}
