/**
 * Small time helpers shared by notes, search, alerts and the API.
 * Timestamps are stored as milliseconds; humans see mm:ss or h:mm:ss.
 */

/** 75 -> "01:15", 3725 -> "1:02:05" */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function msToClock(ms: number): string {
  return formatClock(ms / 1000);
}

/** "14:20" -> 860, "1:02:05" -> 3725. Returns null when the text is not a clock. */
export function parseClock(text: string): number | null {
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const h = match[1] ? parseInt(match[1], 10) : 0;
  const m = parseInt(match[2]!, 10);
  const s = parseInt(match[3]!, 10);
  if (s > 59 || (match[1] && m > 59)) return null;
  return h * 3600 + m * 60 + s;
}
