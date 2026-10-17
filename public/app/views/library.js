// Clases: pending captures (with the command to run) and the recordings grouped by subject.
import { api, html, mount, icon, duration, fmtDate, courseLabel, NO_COURSE, toast, copyText, fold } from '../util.js';
import { state, applyMeta, refreshMeta, renderRoute } from '../main.js';

let query = '';

function materials(r) {
  return html`<div class="tags">
    ${r.has_audio ? html`<span class="tag">Audio</span>` : ''}
    ${r.has_notes ? html`<span class="tag tag-green">Apuntes</span>` : ''}
    ${r.alert_count ? html`<span class="tag tag-orange">${r.alert_count} ${r.alert_count === 1 ? 'aviso' : 'avisos'}</span>` : ''}
    ${r.flashcard_count ? html`<span class="tag tag-blue">${r.flashcard_count} ${r.flashcard_count === 1 ? 'tarjeta' : 'tarjetas'}</span>` : ''}
  </div>`;
}

function row(r) {
  return html`<tr>
    <td class="sel"><input type="checkbox" data-sel="${r.id}" aria-label="Seleccionar ${r.title}"></td>
    <td class="name"><a href="#/r/${r.id}">${r.title}</a></td>
    <td class="date hide-sm">${fmtDate(r.created_at)}</td>
    <td class="num hide-sm">${duration(r.duration_seconds)}</td>
    <td>${materials(r)}</td>
    <td class="acts">${!r.has_notes && state.ai ? html`<button class="btn sm row-acts" data-process="${r.id}" type="button">Generar con IA</button>` : ''}</td>
  </tr>`;
}

function pendingRow(p) {
  return html`<tr>
    <td class="name">${p.title}</td>
    <td class="hide-sm"><span class="muted small">${p.course ? p.course.split(' ')[0] : ''}</span></td>
    <td class="date hide-sm">${fmtDate(p.created_at)}</td>
    <td class="num hide-sm">${duration(p.duration_seconds)}</td>
    <td class="acts"><button class="btn sm" data-copy="${p.command}" type="button">${icon('copy', 14)} Copiar comando</button></td>
  </tr>`;
}

export async function renderLibrary(root) {
  const courseQs = state.course ? `course=${encodeURIComponent(state.course)}` : '';
  const [data, pendingData] = await Promise.all([
    api(`/api/recordings${courseQs ? `?${courseQs}` : ''}`),
    api('/api/pending'),
  ]);
  applyMeta({ ...data, pending: pendingData.pending.length });
  const q = fold(query);
  const all = data.recordings.filter((r) => r.segment_count > 0);
  const rs = all.filter((r) => !q || fold(r.title).includes(q));
  const pending = pendingData.pending.filter((p) => !state.course || (state.course === NO_COURSE ? !p.course : p.course === state.course));

  const groups = new Map();
  for (const r of rs) {
    if (!groups.has(r.course)) groups.set(r.course, []);
    groups.get(r.course).push(r);
  }
  const withNotes = all.filter((r) => r.has_notes).length;

  mount(root, html`
    <h1 class="page-title">${state.course ? courseLabel(state.course) : 'Clases'}</h1>
    <p class="page-sub">${all.length ? `${all.length} ${all.length === 1 ? 'clase' : 'clases'} capturadas, ${withNotes} con apuntes.` : 'Todavía no hay clases capturadas.'}${pending.length ? ` ${pending.length} pendientes de capturar.` : ''}</p>

    <div class="toolbar">
      <label class="sr-only" for="filter">Filtrar por nombre</label>
      <input class="input" id="filter" type="search" placeholder="Filtrar por nombre" value="${query}" style="width:240px">
      <span class="spacer"></span>
      <button class="btn" data-ingest type="button" title="Importar las transcripciones de data/transcripts">Importar transcripciones</button>
    </div>

    <div class="bulk" id="bulk" hidden>
      <span><b id="bulk-n">0</b> seleccionadas</span>
      <label class="sr-only" for="bulk-course">Asignatura destino</label>
      <input class="input" id="bulk-course" list="bulk-dl" placeholder="Asignatura o número (03)" maxlength="120">
      <datalist id="bulk-dl">${[...new Set([...state.catalog.map((c) => c.label), ...state.courses.map((c) => c.course).filter(Boolean)])].map((c) => html`<option value="${c}"></option>`)}</datalist>
      <button class="btn primary sm" id="bulk-go" type="button">Mover a asignatura</button>
      <button class="btn ghost sm" id="bulk-none" type="button">Quitar asignatura</button>
    </div>

    ${pending.length ? html`
      <h2 class="section">Pendientes de capturar <span class="muted">${pending.length}</span></h2>
      <p class="muted small" style="margin-bottom:8px">Ejecuta el comando en PowerShell dentro de la carpeta del proyecto. Se abre el navegador, tú pones Play en la clase y pulsas Enter.</p>
      <div class="cmd" style="margin-bottom:10px"><code>${pendingData.batch}</code>
        <button class="btn sm" data-copy="${pendingData.batch}" type="button">${icon('copy', 14)} Copiar</button></div>
      <table class="db pending"><thead><tr><th>Nombre</th><th class="hide-sm">Asignatura</th><th class="hide-sm">Fecha</th><th class="hide-sm">Duración</th><th></th></tr></thead>
        <tbody>${pending.map(pendingRow)}</tbody></table>` : ''}

    ${rs.length === 0 && !pending.length ? html`
      <div class="empty"><h3>No hay clases</h3>
        <p>Sincroniza la lista de Collab2 con <code>npm run sync</code> para ver aquí lo que falta por capturar, o importa transcripciones que ya tengas.</p></div>`
    : [...groups.entries()].map(([course, items]) => html`
      <h2 class="section">${courseLabel(course)} <span class="muted">${items.length}</span></h2>
      <table class="db classes"><thead><tr>
        <th class="sel"><input type="checkbox" data-sel-all aria-label="Seleccionar todas"></th>
        <th>Nombre</th><th class="hide-sm">Fecha</th><th class="hide-sm">Duración</th><th>Material</th><th></th></tr></thead>
        <tbody>${items.map(row)}</tbody></table>`)}
  `);

  root.querySelector('#filter').addEventListener('input', (e) => {
    query = e.target.value;
    renderLibrary(root);
  });
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    toast((await copyText(b.dataset.copy)) ? 'Comando copiado' : 'No se pudo copiar', 'ok');
  }));
  root.querySelector('[data-ingest]').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const { result } = await api('/api/ingest', { method: 'POST', body: {} });
      toast(`Importadas ${result.created + result.linked} clases, ${result.importedNotes} apuntes`);
      await refreshMeta(); await renderRoute();
    } catch (err) { toast(err.message, 'err'); e.currentTarget.disabled = false; }
  });
  root.querySelectorAll('[data-process]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Procesando';
    try {
      const { report } = await api(`/api/recordings/${b.dataset.process}/process`, { method: 'POST', body: {} });
      toast(report.errors.length ? report.errors[0] : `Listo: ${report.alerts} avisos, ${report.flashcards} tarjetas`, report.errors.length ? 'err' : 'ok');
      await refreshMeta(); await renderRoute();
    } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = 'Generar con IA'; }
  }));

  // Bulk selection
  const bulk = root.querySelector('#bulk');
  const selected = () => [...root.querySelectorAll('[data-sel]:checked')].map((b) => Number(b.dataset.sel));
  const syncBulk = () => { const n = selected().length; bulk.hidden = n === 0; root.querySelector('#bulk-n').textContent = String(n); };
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-sel-all]')) e.target.closest('table').querySelectorAll('[data-sel]').forEach((b) => { b.checked = e.target.checked; });
    if (e.target.matches('[data-sel], [data-sel-all]')) syncBulk();
  });
  const assign = async (course) => {
    try {
      const res = await api('/api/recordings/assign', { method: 'POST', body: { ids: selected(), course } });
      toast(`${res.updated} clase(s) movidas a ${res.course || 'sin asignatura'}`);
      await refreshMeta(); await renderRoute();
    } catch (err) { toast(err.message, 'err'); }
  };
  root.querySelector('#bulk-go').addEventListener('click', () => {
    const v = root.querySelector('#bulk-course').value.trim();
    if (v) assign(v); else toast('Escribe o elige una asignatura', 'err');
  });
  root.querySelector('#bulk-none').addEventListener('click', () => assign(NO_COURSE));
}
