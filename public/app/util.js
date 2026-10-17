// Shared helpers: safe templating, API client, formatting, markdown + math, toasts, theme.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Marks a string as already-safe HTML. Everything else interpolated into html`` is escaped. */
export const raw = (s) => ({ __raw: String(s) });
const toStr = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (typeof v === 'object' && '__raw' in v) return v.__raw;
  if (Array.isArray(v)) return v.map(toStr).join('');
  return esc(v);
};
/** Tagged template: auto-escapes interpolations (use raw() or nested html`` for markup). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < vals.length ? toStr(vals[i]) : ''); });
  return raw(out);
}
export const mount = (el, tpl) => { el.innerHTML = tpl.__raw; return el; };

export async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  // The server only accepts JSON for anything that changes data (a CSRF guard), so even body-less DELETEs send {}
  if (init.method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body ?? {});
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

// ── formatting ─────────────────────────────────────────────
/** True while the user is typing in a form control (global shortcuts must stay out of the way). */
export const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

/** Local calendar day as YYYY-MM-DD (never UTC: the student's day is the one on their wall). */
export const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Lower-case + strip accents, matching what the FTS tokenizer does on the server. */
export const fold = (t) => String(t).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

export const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(x).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
export const msClock = (ms) => clock(ms / 1000);
export function duration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
export function fmtDate(value, withTime = false) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  return d.toLocaleDateString('es-ES', {
    day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Days from today to an ISO date (YYYY-MM-DD) in local time. */
export function daysUntil(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((new Date(y, m - 1, d) - startOfDay(new Date())) / 86400000);
}
export function relativeDay(iso) {
  const n = daysUntil(iso);
  if (n === 0) return 'hoy';
  if (n === 1) return 'mañana';
  if (n === -1) return 'ayer';
  return n > 0 ? `en ${n} días` : `hace ${-n} días`;
}
export const isoParts = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d, date: new Date(y, m - 1, d) };
};

/** Alert kinds: a text label and a muted tag colour (never colour alone). */
export const KINDS = {
  exam: { label: 'Examen', tag: 'blue', color: 'var(--tag-blue-fg)' },
  deadline: { label: 'Entrega', tag: 'orange', color: 'var(--tag-orange-fg)' },
  grading: { label: 'Evaluación', tag: 'green', color: 'var(--tag-green-fg)' },
  warning: { label: 'Aviso', tag: 'yellow', color: 'var(--tag-yellow-fg)' },
  formula: { label: 'Fórmula', tag: 'purple', color: 'var(--tag-purple-fg)' },
};
export const kindChip = (kind) => {
  const k = KINDS[kind] || { label: kind, tag: 'gray' };
  return html`<span class="tag tag-${k.tag}">${k.label}</span>`;
};

/** Sidebar/URL value for recordings that have no course yet */
export const NO_COURSE = '__none__';
export const courseLabel = (c) => (!c || c === NO_COURSE ? 'Sin asignatura' : c);

// ── line icons (one consistent set, no emoji) ───────────────
const ICONS = {
  library: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5v-13zM14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14V4z"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  cards: '<rect x="3" y="7" width="14" height="11" rx="2"/><path d="M7 7V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/>',
  chat: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  edit: '<path d="M5 19l1-4L16 5l3 3L9 18l-4 1z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1"/>',
  back: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>',
  fwd: '<path d="M20 12a8 8 0 1 1-3-6.2M20 4v4h-4"/>',
  flag: '<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 5v4h4M12 8v4l3 2"/>',
  contrast: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  terminal: '<path d="M5 7l5 5-5 5M12 18h7"/>',
};
export const icon = (name, size = 16) => raw(
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`
);

// ── markdown + math + clickable timestamps ─────────────────
const CLOCK_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
const HAS_CLOCK = /\[\d{1,2}:\d{2}(?::\d{2})?\]/;
const toSeconds = (c) => c.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);

function extractMath(src) {
  const store = [];
  const keep = (display) => (_, expr) => {
    store.push({ expr: expr.trim(), display });
    return `@@MATH${store.length - 1}@@`;
  };
  const text = src
    .replace(/\$\$([\s\S]+?)\$\$/g, keep(true))
    .replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, keep(false));
  return { text, store };
}

function renderMath(htmlStr, store) {
  return htmlStr.replace(/@@MATH(\d+)@@/g, (_, i) => {
    const m = store[Number(i)];
    if (!m) return '';
    try {
      return window.katex.renderToString(m.expr, { displayMode: m.display, throwOnError: false, output: 'html', strict: 'ignore' });
    } catch { return esc(m.expr); }
  });
}

/** Turn [mm:ss] text into <button class="ts" data-t="…"> inside an already-sanitised DOM. */
function stampTimestamps(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('code, pre, button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  // A fresh, non-global regex per test: a shared /g regex keeps `lastIndex` between nodes and skips matches
  while (walker.nextNode()) if (HAS_CLOCK.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    for (const m of text.matchAll(CLOCK_RE)) {
      frag.append(text.slice(last, m.index));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ts';
      b.dataset.t = String(toSeconds(m[1]));
      b.title = `Ir al minuto ${m[1]}`;
      b.textContent = m[1];
      frag.append(b);
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** Render untrusted Markdown safely: marked → DOMPurify → timestamps → KaTeX. */
export function renderMarkdown(markdown, { timestamps = true } = {}) {
  const { text, store } = extractMath(String(markdown || ''));
  const dirty = window.marked.parse(text, { gfm: true, breaks: false });
  const clean = window.DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
  const box = document.createElement('div');
  box.innerHTML = clean;
  for (const a of box.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  if (timestamps) stampTimestamps(box);
  box.innerHTML = renderMath(box.innerHTML, store);
  return box;
}

/** Replace Anki cloze markers {{c1::answer}} (answers may contain balanced braces, e.g. TeX). */
function replaceCloze(str, fn) {
  let out = '';
  let i = 0;
  const re = /\{\{c\d+::/g;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(str);
    if (!m) { out += str.slice(i); break; }
    out += str.slice(i, m.index);
    const start = m.index + m[0].length;
    let depth = 0, end = -1;
    for (let j = start; j < str.length; j++) {
      const ch = str[j];
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0 && str[j + 1] === '}') { end = j; break; }
        depth--;
      }
    }
    if (end < 0) { out += str.slice(m.index); break; }
    out += fn(str.slice(start, end));
    i = end + 2;
  }
  return out;
}

/**
 * Flashcard text: escaped, with $math$ via KaTeX and cloze holes. `reveal` shows the answers.
 * Never goes through innerHTML unescaped: only KaTeX output and our own spans are raw.
 */
export function richText(input, { reveal = false } = {}) {
  const answers = [];
  const withHoles = replaceCloze(String(input || ''), (ans) => { answers.push(ans); return `@@CLOZE${answers.length - 1}@@`; });
  const { text, store } = extractMath(withHoles);
  let out = esc(text).replace(/\n/g, '<br>');

  out = out.replace(/@@MATH(\d+)@@/g, (_, i) => {
    const m = store[Number(i)];
    if (!m) return '';
    const expr = m.expr.replace(/@@CLOZE(\d+)@@/g, (_x, j) => (reveal ? `\\boxed{${answers[Number(j)]}}` : '\\boxed{\\phantom{0000}}'));
    try {
      return window.katex.renderToString(expr, { displayMode: m.display, throwOnError: false, output: 'html', strict: 'ignore' });
    } catch { return esc(m.expr); }
  });
  out = out.replace(/@@CLOZE(\d+)@@/g, (_, j) =>
    reveal ? `<span class="cloze-ans">${esc(answers[Number(j)])}</span>` : '<span class="cloze-hole">_____</span>');
  return raw(out);
}

/** Snippets from search carry \u0001/\u0002 around matches; escape everything else. */
export function highlight(snippet) {
  return raw(esc(snippet).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>'));
}

// ── toasts + confirm dialog ─────────────────────────────────
export function toast(message, kind = 'ok', ms = 3800) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${kind === 'err' ? ' err' : ''}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Native <dialog> confirmation; resolves true/false. */
export function confirmDialog(message, { confirm = 'Aceptar', danger = false, detail = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = `<form method="dialog"><p class="modal-title"></p><p class="modal-detail"></p>
      <div class="modal-actions"><button class="btn" value="no">Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" value="yes"></button></div></form>`;
    dlg.querySelector('.modal-title').textContent = message;
    dlg.querySelector('.modal-detail').textContent = detail;
    dlg.querySelector('.modal-detail').hidden = !detail;
    dlg.querySelector('[value="yes"]').textContent = confirm;
    dlg.addEventListener('close', () => { const ok = dlg.returnValue === 'yes'; dlg.remove(); resolve(ok); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Copy text to the clipboard (falls back to a hidden textarea on non-secure origins). */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; document.body.append(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove();
  return ok;
}
