/**
 * Exporters: Anki text import (TSV), iCalendar (.ics) and Obsidian-style Markdown.
 * All pure functions → easy to test and safe (everything user/AI-controlled is escaped).
 */

import type { AlertRow, FlashcardRow } from '../database/StudyRepository.js';
import type { RecordingRow } from '../types.js';
import { msToClock } from '../utils/time.js';
import { addDays, parseIso, toIso } from './dates.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Anki ──────────────────────────────────────────────────────────────────

/** Plain text → single-line HTML (Anki is imported with #html:true). */
function htmlText(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>').replace(/\t/g, ' ');
}

/** A leading/embedded quote would be read as CSV quoting by Anki → wrap and double quotes. */
function ankiQuote(html: string): string {
  return html.includes('"') ? `"${html.replace(/"/g, '""')}"` : html;
}

function ankiTag(text: string): string {
  return text.trim().replace(/[\s:]+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '');
}

function ankiDeck(course: string): string {
  const name = (course || 'Sin asignatura').replace(/[:\s]+/g, ' ').trim();
  return `LectureVault::${name}`;
}

/**
 * Anki "Import File" text. Two files are needed because Basic and Cloze are different note
 * types: call once per kind. The guid column makes re-importing update cards instead of
 * duplicating them.
 */
export function buildAnkiTsv(cards: FlashcardRow[], kind: 'basic' | 'cloze'): string {
  const lines = [
    '#separator:tab',
    '#html:true',
    `#notetype:${kind === 'cloze' ? 'Cloze' : 'Basic'}`,
    '#guid column:1',
    '#deck column:2',
    '#tags column:5',
  ];

  for (const c of cards.filter((card) => card.kind === kind)) {
    const source = `<small>${escapeHtml(`🎧 ${c.recording_title ?? ''} · ${msToClock(c.t_ms)}`.trim())}</small>`;
    const back = [c.back ? htmlText(c.back) : '', source].filter(Boolean).join('<br><br>');
    const tags = ['lecturevault', c.course ? ankiTag(c.course) : '', c.tag ? ankiTag(c.tag) : '']
      .filter(Boolean)
      .join(' ');

    lines.push(
      [c.guid, ankiQuote(htmlText(ankiDeck(c.course ?? ''))), ankiQuote(htmlText(c.front)), ankiQuote(back), tags].join('\t')
    );
  }
  return lines.join('\n') + '\n';
}

// ── iCalendar ─────────────────────────────────────────────────────────────

const ICS_ICON: Record<string, string> = {
  exam: '📝', deadline: '⏰', grading: '📊', warning: '⚠️', formula: '∑',
};

function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** RFC 5545 §3.1: lines are folded at 75 *octets*; continuation lines start with one space. */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // continuation lines lose one octet to the leading space
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function icsDate(iso: string): string {
  return iso.replace(/-/g, '');
}

function icsNextDay(iso: string): string {
  const day = parseIso(iso);
  return day ? toIso(addDays(day, 1)).replace(/-/g, '') : icsDate(iso);
}

function icsStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** All-day events for alerts that have a due date. UIDs are stable, so re-importing updates events. */
export function buildIcs(alerts: AlertRow[], options: { now?: Date; calendarName?: string } = {}): string {
  const now = options.now ?? new Date();
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LectureVault//Study Copilot//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(options.calendarName ?? 'LectureVault')}`,
  ];

  for (const a of alerts) {
    if (!a.due_date || a.dismissed) continue;
    const icon = ICS_ICON[a.kind] ?? '•';
    const summary = `${icon} ${a.text}`.slice(0, 120);
    const description = [
      a.course ? `Asignatura: ${a.course}` : '',
      a.recording_title ? `Clase: ${a.recording_title} (${msToClock(a.t_ms)})` : '',
      a.quote ? `"${a.quote}"` : '',
      a.confirmed ? '' : 'Sin confirmar: revisa el audio antes de fiarte de esta fecha.',
    ].filter(Boolean).join('\n');

    lines.push(
      'BEGIN:VEVENT',
      `UID:alert-${a.id}@lecturevault.local`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART;VALUE=DATE:${icsDate(a.due_date)}`,
      `DTEND;VALUE=DATE:${icsNextDay(a.due_date)}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      `CATEGORIES:${icsEscape(a.kind)}`,
      `STATUS:${a.confirmed ? 'CONFIRMED' : 'TENTATIVE'}`,
      'TRANSP:TRANSPARENT'
    );
    const triggers = a.kind === 'exam' || a.kind === 'deadline' ? ['-P7D', '-P1D'] : ['-P1D'];
    for (const trigger of triggers) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(summary)}`, `TRIGGER:${trigger}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// ── Obsidian / Markdown vault ─────────────────────────────────────────────

function yamlString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

/** Filesystem-safe note name: no separators, reserved characters or leading dots. */
export function noteFileName(recording: Pick<RecordingRow, 'title' | 'created_at'>): string {
  const date = recording.created_at.slice(0, 10);
  const title = recording.title.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return `${date} ${title || 'Clase'}`.trim().slice(0, 120);
}

export function renderObsidianNote(
  recording: RecordingRow,
  notesMarkdown: string,
  alerts: AlertRow[],
  cards: FlashcardRow[]
): string {
  const front = [
    '---',
    `title: ${yamlString(recording.title)}`,
    `course: ${yamlString(recording.course)}`,
    `date: ${recording.created_at.slice(0, 10)}`,
    `duration_min: ${Math.round(recording.duration_seconds / 60)}`,
    'tags: [lecturevault, clase]',
    '---',
    '',
  ];

  const parts = [front.join('\n'), notesMarkdown.trim(), ''];

  const live = alerts.filter((a) => !a.dismissed);
  if (live.length) {
    parts.push('## ⚠️ Avisos críticos', '');
    for (const a of live) {
      const due = a.due_date ? ` — **${a.due_date}**` : '';
      parts.push(`- ${ICS_ICON[a.kind] ?? '•'} ${a.text}${due} _(${msToClock(a.t_ms)})_`);
    }
    parts.push('');
  }

  if (cards.length) {
    parts.push('## 🃏 Tarjetas', '');
    for (const c of cards) {
      parts.push(c.kind === 'cloze' ? `- ${c.front.replace(/\{\{c\d+::(.+?)\}\}/g, '==$1==')}` : `- **${c.front}** → ${c.back}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}
