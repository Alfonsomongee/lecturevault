import { describe, it, expect } from 'vitest';
import { DiagnosticsManager } from '../../src/utils/diagnostics.js';

describe('Player Diagnostics Strict Sanitization Regression Tests', () => {
  it('strictly removes all cloudfront and bbcollab CDN domain references', () => {
    const raw = `
      <div class="video-container">
        <video src="https://ultra-eu-prod-sms.cloudfront.cdn.bbcollab.com/content/abc/video.mp4?token=123"></video>
        <img src="https://custom.cloudfront.net/img.png" />
      </div>
    `;

    const sanitized = DiagnosticsManager.sanitizeHtml(raw);
    expect(sanitized.toLowerCase()).not.toContain('cloudfront');
    expect(sanitized.toLowerCase()).not.toContain('bbcollab.com');
  });

  it('strictly removes all http:// and https:// URLs', () => {
    const raw = `
      <div>
        <a href="https://example.com/stream">Stream Link</a>
        <video src="http://insecure-host.org/video.mp4" poster="https://cdn.example.com/poster.jpg"></video>
      </div>
    `;

    const sanitized = DiagnosticsManager.sanitizeHtml(raw);
    expect(sanitized).not.toContain('https://');
    expect(sanitized).not.toContain('http://');
  });

  it('strictly strips entire <source> and <track> tags', () => {
    const raw = `
      <video>
        <source src="https://cdn.example.com/manifest.mp4" type="video/mp4" />
        <track src="https://cdn.example.com/es.vtt" kind="subtitles" srclang="es" label="Español" />
      </video>
    `;

    const sanitized = DiagnosticsManager.sanitizeHtml(raw);
    expect(sanitized).not.toContain('<source');
    expect(sanitized).not.toContain('<track');
    expect(sanitized).toContain('<!-- [REDACTED SOURCE] -->');
    expect(sanitized).toContain('<!-- [REDACTED TRACK] -->');
  });

  it('strictly strips media attributes: src, currentSrc, srcset, href, and poster', () => {
    const raw = `
      <video src="media.mp4" currentSrc="media.mp4" poster="poster.png" data-src="media.mp4">
        <a href="/download">Download</a>
        <img srcset="pic.png 2x" />
      </video>
    `;

    const sanitized = DiagnosticsManager.sanitizeHtml(raw);
    expect(sanitized).not.toContain('media.mp4');
    expect(sanitized).not.toContain('poster.png');
    expect(sanitized).not.toContain('pic.png');
    expect(sanitized).toContain('src="[REDACTED_REF]"');
    expect(sanitized).toContain('poster="[REDACTED_REF]"');
    expect(sanitized).toContain('href="[REDACTED_REF]"');
  });

  it('strictly removes recording and session IDs / UUIDs and hex hashes', () => {
    const raw = `
      <div data-id="8bbb47e3-53d2-4731-93dc-f9f574a5be23" data-recording-id="8bbb47e353d2473193dcf9f574a5be23">
        <span recordingUid="8bbb47e3-53d2-4731-93dc-f9f574a5be23">Session</span>
      </div>
    `;

    const sanitized = DiagnosticsManager.sanitizeHtml(raw);
    expect(sanitized).not.toContain('8bbb47e3-53d2-4731-93dc-f9f574a5be23');
    expect(sanitized).not.toContain('8bbb47e353d2473193dcf9f574a5be23');
    expect(sanitized).toContain('[REDACTED_UUID]');
  });
});
