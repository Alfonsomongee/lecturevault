// Resultados de búsqueda: agrupados por clase, cada coincidencia salta al minuto exacto.
import { api, html, mount, highlight, msClock, courseLabel } from '../util.js';
import { state } from '../main.js';

export async function renderSearch(root, params) {
  const q = (params.get('q') || '').trim();
  const input = document.getElementById('global-search');
  if (document.activeElement !== input) input.value = q;

  if (q.length < 2) {
    mount(root, html`<h1 class="page-title">Buscar</h1>
      <p class="page-sub">Escribe un término en el cuadro de la izquierda. Busca en transcripciones y apuntes de todas las clases, sin importar acentos ni plurales, y tolera errores del reconocimiento de voz.</p>
      <div class="tags">${['restricciones', 'examen', 'Von Mises', 'foro'].map((s) => html`<a class="btn sm" href="#/search?q=${encodeURIComponent(s)}">${s}</a>`)}</div>`);
    return;
  }

  const t0 = performance.now();
  const data = await api(`/api/search?q=${encodeURIComponent(q)}${state.course ? `&course=${encodeURIComponent(state.course)}` : ''}`);
  const ms = Math.max(1, Math.round(performance.now() - t0));

  const groups = new Map();
  for (const h of data.hits) {
    if (!groups.has(h.recordingId)) groups.set(h.recordingId, { title: h.recordingTitle, course: h.course, hits: [] });
    groups.get(h.recordingId).hits.push(h);
  }

  mount(root, html`
    <h1 class="page-title">${q}</h1>
    <p class="page-sub">${data.hits.length ? `${data.hits.length} ${data.hits.length === 1 ? 'resultado' : 'resultados'} en ${groups.size} ${groups.size === 1 ? 'clase' : 'clases'} (${ms} ms)` : 'Sin resultados'}${state.course ? ` · ${courseLabel(state.course)}` : ''}</p>
    ${data.corrected.length ? html`<div class="note-banner">Se muestran resultados para <b>${data.corrected.map((c) => c.to).join(', ')}</b>. No aparece «${data.corrected.map((c) => c.from).join('», «')}» en tus clases; el reconocimiento de voz a veces se equivoca con términos técnicos.</div>` : ''}
    ${data.hits.length === 0 ? html`<div class="empty"><p>Prueba con otra palabra o con menos términos. También puedes <a href="#/ask?q=${encodeURIComponent(q)}" style="text-decoration:underline">hacer la pregunta</a>.</p></div>`
    : [...groups.entries()].map(([id, g]) => html`
      <section class="hit-group">
        <h3><a href="#/r/${id}" style="border-bottom:1px solid var(--border-strong)">${g.title}</a>${g.course ? html`<span class="tag">${g.course.split(' ')[0]}</span>` : ''}</h3>
        ${g.hits.map((h) => html`<button class="hit" type="button" data-go="#/r/${id}?t=${Math.floor(h.startMs / 1000)}${h.source === 'notes' ? '&tab=notes' : '&tab=transcript'}">
          <span class="t">${msClock(h.startMs)}</span>
          <span style="min-width:0"><span class="snippet">${highlight(h.snippet)}</span>
            <span class="muted small" style="display:block">${h.source === 'notes' ? 'En los apuntes' : 'En la transcripción'}</span></span></button>`)}
      </section>`)}
  `);
  root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
}
