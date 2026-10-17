/**
 * Identifier helpers shared by capture, ingestion and the dashboard API.
 */

/**
 * Turns an arbitrary id/title into a safe single path segment
 * (no traversal, no separators). Used for audio/transcript file stems.
 */
export function sanitizeRecordingId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_{2,}/g, '_');
  return cleaned.slice(0, 80) || `recording-${Date.now()}`;
}

/** A transcript id coming from the network must match this to be used as a folder name. */
export function isSafeTranscriptId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}
