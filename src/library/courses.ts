/**
 * Course catalog: the student's subjects (data/courses.json), with short aliases and detection.
 *
 * - `resolve("03")`, `resolve("03MUIN")`, `resolve("sistemas eléctricos")` → "03MUIN Sistemas eléctricos…"
 * - `detect(text)` finds a course code or LMS id inside a recording title / URL.
 * Anything unknown or ambiguous is left alone: a wrong automatic assignment is worse than none.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fold } from '../utils/text.js';

export interface CatalogCourse {
  code: string;
  name: string;
  teacher?: string;
  /** Blackboard course id, e.g. 2026_10_A_51178 */
  lmsId?: string;
}

export const COURSES_FILE = 'courses.json';

export function courseLabel(c: CatalogCourse): string {
  return `${c.code} ${c.name}`.trim();
}

export class CourseCatalog {
  readonly courses: CatalogCourse[];

  constructor(courses: CatalogCourse[] = []) {
    this.courses = courses.filter((c) => c && typeof c.code === 'string' && typeof c.name === 'string');
  }

  static load(dataDir: string): CourseCatalog {
    const file = path.join(dataDir, COURSES_FILE);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return new CourseCatalog(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new CourseCatalog();
    }
  }

  /** Copy the example catalog into data/ unless one already exists. Returns true if created. */
  static init(dataDir: string, examplePath: string): boolean {
    const target = path.join(dataDir, COURSES_FILE);
    if (fs.existsSync(target)) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(examplePath, target);
    return true;
  }

  get labels(): string[] {
    return this.courses.map(courseLabel);
  }

  /** Match a user-typed value to exactly one course, or undefined. */
  find(input: string): CatalogCourse | undefined {
    const q = fold(input).trim();
    if (!q) return undefined;
    const compact = q.replace(/[\s_-]+/g, '');

    const exact = this.courses.filter((c) =>
      [fold(c.code), fold(courseLabel(c)), fold(c.name), fold(c.lmsId ?? '')].some((v) => v && v.replace(/[\s_-]+/g, '') === compact)
    );
    if (exact.length === 1) return exact[0];

    // "MUIN03", "muin 3", "3muin" → code written the other way round
    const reversed = this.courses.filter((c) => {
      const code = fold(c.code);
      const letters = code.replace(/\d+/g, '');
      const n = parseInt(code.replace(/\D+/g, ''), 10);
      return [`${letters}${n}`, `${letters}${String(n).padStart(2, '0')}`, `${n}${letters}`].includes(compact);
    });
    if (reversed.length === 1) return reversed[0];

    // "3", "03" → the course whose code starts with that number
    const num = /^0*(\d{1,2})$/.exec(q);
    if (num) {
      const n = parseInt(num[1]!, 10);
      const byNumber = this.courses.filter((c) => parseInt(/^\d+/.exec(c.code)?.[0] ?? '-1', 10) === n);
      if (byNumber.length === 1) return byNumber[0];
    }

    // unique prefix/substring of the name ("sistemas elec")
    if (q.length >= 4) {
      const partial = this.courses.filter((c) => fold(c.name).includes(q) || fold(c.code).startsWith(q));
      if (partial.length === 1) return partial[0];
    }
    return undefined;
  }

  /** Canonical label for a typed value; unknown values are kept as typed. */
  resolve(input: string): string {
    const found = this.find(input);
    return found ? courseLabel(found) : input.trim();
  }

  /** Look for a course code, LMS id or full name inside free text (titles, URLs). */
  detect(text: string): string | undefined {
    const t = fold(text);
    const hits = this.courses.filter((c) => {
      const code = fold(c.code);
      const codeRe = new RegExp(`(^|[^a-z0-9])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      return codeRe.test(t) || (c.lmsId && t.includes(fold(c.lmsId))) || (fold(c.name).length >= 12 && t.includes(fold(c.name)));
    });
    return hits.length === 1 ? courseLabel(hits[0]!) : undefined;
  }
}
