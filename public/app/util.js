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
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

// ── formatting ─────────────────────────────────────────────
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

export const KINDS = {
  exam: { label: 'Examen', icon: '📝', color: 'var(--k-exam)' },
  deadline: { label: 'Entrega', icon: '⏰', color: 'var(--k-deadline)' },
  grading: { label: 'Evaluación', icon: '📊', color: 'var(--k-grading)' },
  warning: { label: 'Aviso', icon: '⚠️', color: 'var(--k-warning)' },
  formula: { label: 'Fórmula', icon: '∑', color: 'var(--k-formula)' },
};
export const kindChip = (kind) => {
  const k = KINDS[kind] || { label: kind, icon: '•', color: 'var(--muted)' };
  return html`<span class="kind" style="--c:${k.color}">${k.icon} ${k.label}</span>`;
};

// A stable colour per course so sidebar dots and tables agree
const COURSE_COLORS = ['var(--k-exam)', 'var(--k-deadline)', 'var(--k-grading)', 'var(--k-formula)', 'var(--k-warning)'];
export const courseColor = (courses, name) => {
  const i = courses.findIndex((c) => c.course === name);
  return COURSE_COLORS[(i < 0 ? 0 : i) % COURSE_COLORS.length];
};

// ── markdown + math + clickable timestamps ─────────────────
const CLOCK_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
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
  while (walker.nextNode()) if (CLOCK_RE.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  CLOCK_RE.lastIndex = 0;
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

// ── toasts + theme ─────────────────────────────────────────
export function toast(message, kind = 'ok', ms = 3800) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast${kind === 'err' ? ' err' : ''}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), ms);
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export { store };

export function initTheme() {
  const apply = (t) => { if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  apply(store.get('lv-theme'));
  document.getElementById('theme-btn').addEventListener('click', () => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    store.set('lv-theme', next);
    apply(next);
  });
}
