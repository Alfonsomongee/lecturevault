// App shell: state, hash router, sidebar, global search, shortcuts.
import { api, html, raw, mount, store, initTheme, courseColor, courseLabel, NO_COURSE, toast, isTyping } from './util.js';
import { renderLibrary } from './views/library.js';
import { renderRecording } from './views/recording.js';
import { renderSearch } from './views/search.js';
import { renderAgenda } from './views/agenda.js';
import { renderStudy } from './views/study.js';
import { renderAsk } from './views/ask.js';

export const state = {
  courses: [],
  stats: {},
  ai: false,
  course: store.get('lv-course') || '',
};
export const view = () => document.getElementById('view');

export function setCourse(course) {
  state.course = course || '';
  store.set('lv-course', state.course);
  renderRoute();
}

/** Single place where sidebar/nav data is updated (the library view feeds it from its own fetch). */
export function applyMeta(data) {
  state.courses = data.courses || [];
  state.stats = data.stats || {};
  state.ai = !!data.ai;
  if (state.course && !state.courses.some((c) => (c.course || NO_COURSE) === state.course)) state.course = '';
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
    else await renderLibrary(root);
  } catch (err) {
    mount(root, html`<div class="empty-state card"><div class="icon">⚠️</div><h2>No se pudo cargar</h2>
      <p>${err.message}</p><a class="btn" href="#/">Volver a la biblioteca</a></div>`);
  }
  window.scrollTo({ top: 0 });
}

function drawNav(active) {
  const s = state.stats;
  const items = [
    ['', '📚', 'Biblioteca', null],
    ['agenda', '🗓️', 'Agenda', s.alerts || null],
    ['study', '🃏', 'Estudiar', s.flashcardsDue || null],
    ['ask', '💬', 'Preguntar', null],
  ];
  mount(document.getElementById('nav'), html`${items.map(([route, icon, label, n]) => html`
    <a href="#/${route}" ${active === route || (route === '' && (active === 'r' || active === 'search')) ? raw('aria-current="page"') : ''}>
      <span aria-hidden="true">${icon}</span>${label}${n ? html`<span class="count ${route === 'study' ? 'hot' : ''}">${n}</span>` : ''}
    </a>`)}`);
}
function drawChrome() {
  drawNav(parseHash().parts[0] || '');
  const total = state.courses.reduce((a, c) => a + c.count, 0);
  mount(document.getElementById('side-courses'), html`
    <button class="course-link" type="button" data-course="" aria-pressed="${state.course === ''}">
      <span class="dot" style="background:var(--muted)"></span>Todas<small>${total}</small></button>
    ${state.courses.map((c) => html`
      <button class="course-link" type="button" data-course="${c.course || NO_COURSE}" aria-pressed="${state.course === (c.course || NO_COURSE)}">
        <span class="dot" style="background:${courseColor(state.courses, c.course)}"></span>${courseLabel(c.course)}<small>${c.count}</small></button>`)}`);
  mount(document.getElementById('side-foot'), html`
    <div class="ai-state ${state.ai ? 'on' : ''}"><i></i>${state.ai ? 'IA de Gemini activa' : 'IA desactivada'}</div>
    ${state.ai ? '' : html`<span>Añade <code>GEMINI_API_KEY</code> a <code>.env</code> para generar apuntes, avisos y tarjetas.</span>`}
    <span>100 % local · tus datos no salen de este equipo salvo el texto que envías a Gemini.</span>`);
  document.getElementById('last-sync').textContent = `Actualizado ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

document.getElementById('side-courses').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-course]');
  if (btn) setCourse(btn.dataset.course);
});

// Global search: type anywhere, results update as you type
const input = document.getElementById('global-search');
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
  const typing = isTyping();
  if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

addEventListener('hashchange', renderRoute);

(async function boot() {
  initTheme();
  try {
    await refreshMeta();
  } catch (err) {
    toast(`No se pudo conectar con el servidor: ${err.message}`, 'err', 8000);
  }
  await renderRoute();
  setInterval(() => { refreshMeta().catch(() => {}); }, 60000);
})();

