/**
 * Text normalisation shared by search, grounding, dedupe and exports.
 * `fold` mirrors what SQLite FTS5 (unicode61 remove_diacritics) does, so JS-side matching agrees with the index.
 */

/** lower-case + strip diacritics */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** fold + collapse whitespace: the key used to compare quotes and detect duplicates */
export function foldWs(text: string): string {
  return fold(text).replace(/\s+/g, ' ').trim();
}
