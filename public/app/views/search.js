// Search results: grouped by class, highlighted, each hit jumps to the exact moment.
import { api, html, mount, highlight, msClock, courseLabel } from '../util.js';
import { state } from '../main.js';

export async function renderSearch(root, params) {
  const q = (params.get('q') || '').trim();
  const input = document.getElementById('global-search');
  if (document.activeElement !== input) input.value = q;

  if (q.length < 2) {
    mount(root, html`<div class="page-head"><div><div class="eyebrow">Búsqueda global</div><h1>Busca en todas tus clases</h1>
      <p>Escribe un término técnico y encuentra en milisegundos cada vez que se dijo, con el minuto exacto. Tolera acentos, plurales y errores del reconocimiento de voz.</p></div></div>
      <div class="card card-pad"><div class="eyebrow" style="margin-bottom:8px">Prueba con</div>
        <div class="chip-row">${['restricciones', 'examen', 'Von Mises', 'CYPE', 'foro'].map((s) => html`<a class="btn sm" href="#/search?q=${encodeURIComponent(s)}">${s}</a>`)}</div></div>`);
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
    <div class="page-head"><div><div class="eyebrow">Búsqueda global${state.course ? ` · ${courseLabel(state.course)}` : ''}</div>
      <h1>“${q}”</h1>
      <p>${data.hits.length ? `${data.hits.length} resultado${data.hits.length === 1 ? '' : 's'} en ${groups.size} clase${groups.size === 1 ? '' : 's'} · ${ms} ms` : 'Sin resultados'}</p></div>
      <a class="btn" href="#/ask?q=${encodeURIComponent(q)}">💬 Preguntar a la IA</a></div>
    ${data.corrected.length ? html`<div class="hint-bar">Mostrando resultados para ${data.corrected.map((c) => html`<b>${c.to}</b>`)}
      (no había «${data.corrected.map((c) => c.from).join('», «')}» en tus clases; el reconocimiento de voz a veces se equivoca con términos técnicos).</div>` : ''}
    ${data.hits.length === 0 ? html`<div class="card empty-state"><div class="icon">🔎</div><h2>Nada por aquí</h2>
      <p>Prueba con otra palabra o con menos términos. También puedes <a href="#/ask?q=${encodeURIComponent(q)}">preguntar a la IA</a>.</p></div>`
    : [...groups.entries()].map(([id, g]) => html`
      <section class="card hit-group">
        <header><a href="#/r/${id}" style="font-weight:700;color:var(--text)">${g.title}</a><span class="badge">${g.course || 'Sin asignatura'}</span>
          <span class="sub">${g.hits.length} coincidencia${g.hits.length === 1 ? '' : 's'}</span></header>
        ${g.hits.map((h) => html`<button class="hit" type="button" data-go="#/r/${id}?t=${Math.floor(h.startMs / 1000)}">
          <span style="color:var(--accent-ink);font-weight:650;font-variant-numeric:tabular-nums;flex:none;padding-top:2px;min-width:44px">${msClock(h.startMs)}</span>
          <span style="min-width:0"><span class="snippet">${highlight(h.snippet)}</span>
            <span class="sub" style="display:block">${h.source === 'notes' ? '📝 en los apuntes' : '🎙 en la transcripción'}</span></span></button>`)}
      </section>`)}
  `);
  root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
}
