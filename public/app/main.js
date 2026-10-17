// App shell: state, hash router, sidebar, global search. Preferences live in the server database.
import { api, html, mount, icon, courseLabel, NO_COURSE, toast, isTyping } from './util.js';
import { renderLibrary } from './views/library.js';
import { renderRecording } from './views/recording.js';
import { renderSearch } from './views/search.js';
import { renderAgenda } from './views/agenda.js';
import { renderStudy } from './views/study.js';
import { renderAsk } from './views/ask.js';
import { renderSettings } from './views/settings.js';

export const state = {
  courses: [],
  catalog: [],
  stats: {},
  pending: 0,
  ai: false,
  course: '',
  theme: 'system',
};
export const view = () => document.getElementById('view');

// ── preferences (stored in SQLite via /api/settings) ───────
function applyTheme() {
  if (state.theme === 'light' || state.theme === 'dark') document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
}
export async function setTheme(theme) {
  state.theme = theme;
  applyTheme();
  await api('/api/settings', { method: 'PUT', body: { theme } }).catch((e) => toast(e.message, 'err'));
}
export function setCourse(course) {
  state.course = course || '';
  api('/api/settings', { method: 'PUT', body: { course: state.course } }).catch(() => {});
  drawChrome();
  renderRoute();
}

/** Single place where sidebar/nav data is updated (the library view feeds it from its own fetch). */
export function applyMeta(data) {
  state.courses = data.courses || [];
  state.catalog = data.catalog || [];
  state.stats = data.stats || {};
  state.pending = data.pending ?? state.pending;
  state.ai = !!data.ai;
  if (state.course && state.course !== NO_COURSE && !state.courses.some((c) => c.course === state.course) && !state.catalog.some((c) => c.label === state.course)) state.course = '';
  drawChrome();
}
/** Light endpoint: counts and courses only, not the whole library. */
export async function refreshMeta() {
  applyMeta(await api('/api/meta'));
}

function parseHash() {
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

let cleanup = null;
export function onLeave(fn) { cleanup = fn; }

export async function renderRoute() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const { parts, params } = parseHash();
  // Fresh container each time: listeners bound by a view die with the old node
  const old = view();
  const root = old.cloneNode(false);
  old.replaceWith(root);
  const name = parts[0] || '';
  root.innerHTML = '<div class="loading"><div class="spinner" role="progressbar" aria-label="Cargando"></div></div>';
  drawNav(name);
  try {
    if (name === 'r' && parts[1]) await renderRecording(root, Number(parts[1]), params);
    else if (name === 'search') await renderSearch(root, params);
    else if (name === 'agenda') await renderAgenda(root);
    else if (name === 'study') await renderStudy(root);
    else if (name === 'ask') await renderAsk(root, params);
    else if (name === 'settings') { root.classList.add('wide'); await renderSettings(root); }
    else await renderLibrary(root);
  } catch (err) {
    mount(root, html`<div class="empty"><h3>No se pudo cargar</h3><p>${err.message}</p><a class="btn" href="#/">Volver a las clases</a></div>`);
  }
  window.scrollTo({ top: 0 });
}

function drawNav(active) {
  const s = state.stats;
  const items = [
    ['', 'library', 'Clases', state.pending ? state.pending : null, false],
    ['agenda', 'calendar', 'Agenda', s.alerts || null, false],
    ['study', 'cards', 'Repaso', s.flashcardsDue || null, true],
    ['ask', 'chat', 'Preguntar', null, false],
  ];
  mount(document.getElementById('nav'), html`${items.map(([route, ico, label, n, hot]) => html`
    <a href="#/${route}" ${active === route || (route === '' && (active === 'r' || active === 'search')) ? html`aria-current="page"` : ''}>
      ${icon(ico)}<span class="clip">${label}</span>${n ? html`<span class="count ${hot ? 'alert' : ''}">${n}</span>` : ''}
    </a>`)}`);
}

function drawChrome() {
  drawNav(parseHash().parts[0] || '');
  const total = state.courses.reduce((n, c) => n + c.count, 0);
  const counts = new Map(state.courses.map((c) => [c.course, c.count]));
  // Catalog subjects always show (even with 0 classes), then any other course, then "unassigned"
  const known = new Set(state.catalog.map((c) => c.label));
  const entries = [
    ...state.catalog.map((c) => ({ value: c.label, label: c.label, n: counts.get(c.label) || 0 })),
    ...state.courses.filter((c) => c.course && !known.has(c.course)).map((c) => ({ value: c.course, label: c.course, n: c.count })),
    ...(counts.get('') ? [{ value: NO_COURSE, label: courseLabel(''), n: counts.get('') }] : []),
  ];
  mount(document.getElementById('side-courses'), html`
    <button type="button" data-course="" aria-pressed="${state.course === ''}"><span class="clip">Todas</span><span class="count">${total}</span></button>
    ${entries.map((e) => html`<button type="button" data-course="${e.value}" aria-pressed="${state.course === e.value}" title="${e.label}">
      <span class="clip">${e.label}</span><span class="count">${e.n}</span></button>`)}`);
  mount(document.getElementById('side-foot'), html`
    <a href="#/settings" ${parseHash().parts[0] === 'settings' ? html`aria-current="page"` : ''}>${icon('settings')}<span class="clip">Ajustes</span></a>`);
}

document.getElementById('side-courses').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-course]');
  if (btn) setCourse(btn.dataset.course);
});

// Global search: type anywhere, results update as you type
const input = document.getElementById('global-search');
mount(document.getElementById('search-ico'), icon('search', 14));
let timer;
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  go(`#/search?q=${encodeURIComponent(input.value.trim())}`);
});
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const q = input.value.trim();
    if (q.length >= 2) history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`), renderRoute();
  }, 220);
});
export function go(hash) { if (location.hash === hash) renderRoute(); else location.hash = hash; }

addEventListener('keydown', (e) => {
  if ((e.key === '/' && !isTyping()) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});
addEventListener('hashchange', renderRoute);

(async function boot() {
  try {
    const { settings } = await api('/api/settings');
    state.theme = settings.theme || 'system';
    state.course = settings.course || '';
    applyTheme();
    await refreshMeta();
  } catch (err) {
    toast(`No se pudo conectar con el servidor: ${err.message}`, 'err', 8000);
  }
  await renderRoute();
  setInterval(() => { refreshMeta().catch(() => {}); }, 60000);
})();
