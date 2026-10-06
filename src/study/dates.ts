/**
 * Deterministic Spanish date handling for deadline alerts.
 *
 * Teachers say "hasta el día 20", "el 3 de abril", "el lunes", "mañana". The LLM proposes an
 * ISO date, but we never trust it blindly: it must be a real calendar date close to the class
 * date, and when the model gives only the phrase we resolve it here against the class date.
 * All math is on calendar dates (UTC midnight) so time zones and DST can't shift a day.
 */

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const DAY_MS = 86_400_000;

export interface CalendarDate {
  y: number;
  m: number; // 1-12
  d: number;
}

export function toIso(date: CalendarDate): string {
  return `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
}

function toUtc(date: CalendarDate): number {
  return Date.UTC(date.y, date.m - 1, date.d);
}

function fromUtc(ms: number): CalendarDate {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function isValidDate({ y, m, d }: CalendarDate): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseIso(iso: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const date = { y: +match[1]!, m: +match[2]!, d: +match[3]! };
  return isValidDate(date) ? date : null;
}

/** Calendar date of an instant in the machine's local time zone (the student's). */
export function localCalendarDate(value: string | Date): CalendarDate {
  const dt = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(dt.getTime()) ? new Date() : dt;
  return { y: safe.getFullYear(), m: safe.getMonth() + 1, d: safe.getDate() };
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

export function weekdayName(date: CalendarDate): string {
  const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  return names[new Date(toUtc(date)).getUTCDay()]!;
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

export interface ResolvedDate {
  date: string;
  confidence: 'high' | 'medium';
}

/**
 * Resolve a spoken date phrase against the class date. Returns null when the phrase is
 * ambiguous ("la semana que viene", "pronto") so a human decides instead of guessing.
 */
export function resolveDateText(text: string, classDate: CalendarDate): ResolvedDate | null {
  const t = fold(text);
  const classMs = toUtc(classDate);

  // "20 de marzo", "20 de marzo de 2027"
  const named = /\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+(?:de|del)\s+(\d{4}))?/.exec(t);
  if (named && MONTHS[named[2]!]) {
    const d = +named[1]!;
    const m = MONTHS[named[2]!]!;
    if (named[3]) {
      const date = { y: +named[3], m, d };
      return isValidDate(date) ? { date: toIso(date), confidence: 'high' } : null;
    }
    let date = { y: classDate.y, m, d };
    if (!isValidDate(date)) return null;
    // no year spoken: a date more than a week in the past means next year
    if (toUtc(date) < classMs - 7 * DAY_MS) date = { y: classDate.y + 1, m, d };
    return isValidDate(date) ? { date: toIso(date), confidence: 'high' } : null;
  }

  if (/\bpasado manana\b/.test(t)) return { date: toIso(addDays(classDate, 2)), confidence: 'high' };
  if (/\bmanana\b/.test(t)) return { date: toIso(addDays(classDate, 1)), confidence: 'high' };

  // "el lunes", "para el viernes" → next such weekday after the class
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) {
      const classDow = new Date(classMs).getUTCDay();
      const delta = ((i - classDow + 7) % 7) || 7;
      return { date: toIso(addDays(classDate, delta)), confidence: 'medium' };
    }
  }

  // "el día 20", "día 5", "hasta el 20": day of month only
  const dayOnly = /\b(?:dia|el)\s+(\d{1,2})\b/.exec(t);
  if (dayOnly) {
    const d = +dayOnly[1]!;
    for (let offset = 0; offset < 14; offset++) {
      const month0 = classDate.m - 1 + offset;
      const candidate = { y: classDate.y + Math.floor(month0 / 12), m: (month0 % 12) + 1, d };
      if (isValidDate(candidate) && toUtc(candidate) >= classMs) {
        return { date: toIso(candidate), confidence: 'medium' };
      }
    }
  }

  return null;
}

/** Accept a model-provided ISO date only if it is a real date near the class date. */
export function sanitizeDueDate(iso: string | null | undefined, classDate: CalendarDate): string | null {
  if (!iso) return null;
  const parsed = parseIso(iso);
  if (!parsed) return null;
  const delta = (toUtc(parsed) - toUtc(classDate)) / DAY_MS;
  return delta >= -2 && delta <= 550 ? toIso(parsed) : null;
}
