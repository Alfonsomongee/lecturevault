// Library: KPI tiles, what's next, and recordings grouped by course.
import { api, html, mount, duration, fmtDate, courseColor, daysUntil, relativeDay, kindChip, toast, esc } from '../util.js';
import { state, refreshMeta, renderRoute, go } from '../main.js';

let filter = 'all';

const tile = (id, label, value, sub = '') => html`
  <div class="card stat"><div class="stat-value" id="${id}">${value}</div><div class="stat-label">${label}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : ''}</div>`;

function badges(r) {
  return html`<div class="badges">
    <span class="badge ${r.has_audio ? 'ok' : 'off'}" title="${r.has_audio ? 'Audio local disponible' : 'Sin audio local'}">🎧 Audio</span>
    <span class="badge ${r.has_notes ? 'ok' : 'off'}" title="${r.has_notes ? 'Apuntes generados' : 'Sin apuntes todavía'}">📝 Apuntes</span>
    ${r.alert_count ? html`<span class="badge" title="Avisos críticos">⚠️ ${r.alert_count}</span>` : ''}
    ${r.flashcard_count ? html`<span class="badge" title="Tarjetas de estudio">🃏 ${r.flashcard_count}</span>` : ''}
  </div>`;
}

function row(r) {
  const open = r.segment_count > 0;
  return html`<tr>
    <td class="title-cell">
      ${open ? html`<a href="#/r/${r.id}">${r.title}</a>` : html`<span>${r.title}</span>`}
      <div class="sub">${open ? `${r.segment_count} segmentos transcritos` : 'Aún sin transcripción'}</div>
    </td>
    <td class="hide-sm"><span class="sub" style="font-size:13.5px">${fmtDate(r.created_at)}</span></td>
    <td class="hide-sm"><span class="duration">${duration(r.duration_seconds)}</span></td>
    <td>${open ? badges(r) : html`<span class="sub">Pendiente de capturar</span>`}</td>
    <td><span class="badge status-badge status-${r.status}">${r.status}</span></td>
    <td style="text-align:right;white-space:nowrap">
      ${open ? html`<a class="btn sm" href="#/r/${r.id}">Abrir</a>` : ''}
      ${open && !r.has_notes && state.ai ? html`<button class="btn sm primary" data-process="${r.id}">✨ Generar con IA</button>` : ''}
      ${r.playback_url ? html`<a class="btn sm ghost" href="${r.playback_url}" target="_blank" rel="noopener noreferrer" title="Abrir en Collaborate">↗</a>` : ''}
    </td>
  </tr>`;
}

export async function renderLibrary(root) {
  const q = new URLSearchParams();
  if (filter !== 'all') q.set('status', filter);
  if (state.course) q.set('course', state.course);
  const [data, alertsData] = await Promise.all([
    api(`/api/recordings${q.size ? `?${q}` : ''}`),
    api(`/api/alerts${state.course ? `?course=${encodeURIComponent(state.course)}` : ''}`),
  ]);
  state.courses = data.courses; state.stats = data.stats; state.ai = data.ai;
  const rs = data.recordings;
  const s = data.stats;

  const upcoming = alertsData.alerts
    .filter((a) => a.due_date && !a.dismissed && daysUntil(a.due_date) >= -1)
    .sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 4);
  const due = s.flashcardsDue || 0;

  const groups = new Map();
  for (const r of rs) {
    if (!groups.has(r.course)) groups.set(r.course, []);
    groups.get(r.course).push(r);
  }

  mount(root, html`
    <div class="page-head">
      <div><div class="eyebrow">Tu campus personal</div><h1>Biblioteca</h1>
        <p>Todas tus clases capturadas, con apuntes, avisos y tarjetas listos para estudiar.</p></div>
      <div class="chip-row">
        <button class="btn" id="ingest-btn" type="button" title="Importar las transcripciones de data/transcripts">📥 Importar transcripciones</button>
      </div>
    </div>

    <div class="kpis">
      ${tile('stat-total', 'Clases', s.total ?? 0)}
      ${tile('stat-new', 'Nuevas', s.new ?? 0, 'sin procesar')}
      ${tile('stat-seen', 'Vistas', s.seen ?? 0)}
      ${tile('stat-processed', 'Procesadas', s.processed ?? 0, `${s.withNotes ?? 0} con apuntes`)}
      ${tile('stat-alerts', 'Avisos activos', s.alerts ?? 0)}
      ${tile('stat-cards', 'Tarjetas', s.flashcards ?? 0, due ? `${due} por repasar` : 'al día')}
    </div>

    <div class="spotlight">
      <section class="card card-pad" aria-labelledby="next-h">
        <h2 id="next-h">🗓️ Lo próximo</h2>
        ${upcoming.length ? upcoming.map((a) => {
          const n = daysUntil(a.due_date);
          return html`<div class="mini-alert">
            <div class="due-badge ${n < 0 ? 'late' : n <= 3 ? 'soon' : ''}"><b>${a.due_date.slice(8)}</b>${relativeDay(a.due_date)}</div>
            <div style="min-width:0"><div>${kindChip(a.kind)}</div>
              <div style="font-weight:600;margin-top:4px">${a.text}</div>
              <div class="sub">${a.course || ''} · <a href="#/r/${a.recording_id}?t=${Math.floor(a.t_ms / 1000)}">escuchar el momento</a></div></div></div>`;
        }) : html`<p class="sub">No hay fechas próximas. Los avisos con fecha aparecerán aquí al procesar tus clases.</p>`}
        <a class="btn sm ghost" href="#/agenda" style="margin-top:10px">Ver agenda completa →</a>
      </section>
      <section class="card card-pad" aria-labelledby="rev-h">
        <h2 id="rev-h">🃏 Repaso de hoy</h2>
        ${due ? html`<div class="stat-value" style="font-size:44px">${due}</div><p class="sub" style="margin:4px 0 14px">tarjetas listas para repasar</p>
          <a class="btn primary" href="#/study">Empezar repaso</a>`
          : html`<p class="sub">${s.flashcards ? 'Estás al día. Vuelve mañana.' : 'Aún no hay tarjetas: se generan al procesar una clase con IA.'}</p>`}
      </section>
    </div>

    <div class="controls chip-row" style="margin-bottom:16px;justify-content:space-between">
      <div class="chip-row filters" role="group" aria-label="Filtrar por estado">
        ${[['all', 'Todas'], ['new', 'Nuevas'], ['seen', 'Vistas'], ['processed', 'Procesadas']].map(([k, l]) =>
          html`<button class="filter-btn ${filter === k ? 'active' : ''}" data-filter="${k}" type="button">${l}</button>`)}
      </div>
      ${state.course ? html`<span class="badge">Asignatura: ${state.course} <button class="btn sm ghost" data-clear-course type="button" aria-label="Quitar filtro">✕</button></span>` : ''}
    </div>

    ${rs.length === 0 ? html`
      <div class="card empty-state"><div class="icon">📭</div><h2>No hay grabaciones</h2>
        <p>Sincroniza tus clases con <code>npm run sync</code>, captura una con <code>npm run capture:and:transcribe</code>, o ve cómo funciona todo con <code>npm run demo</code>.</p>
        <button class="btn primary" id="ingest-btn-2" type="button">📥 Importar transcripciones existentes</button></div>`
    : [...groups.entries()].map(([course, items]) => {
        const info = state.courses.find((c) => c.course === course) || { count: items.length, totalSeconds: 0 };
        const done = items.filter((r) => r.has_notes).length;
        const pct = items.length ? Math.round((done / items.length) * 100) : 0;
        return html`<section class="card course-block" aria-label="${course || 'Sin asignatura'}">
          <div class="course-head">
            <span class="dot" style="width:12px;height:12px;border-radius:4px;background:${courseColor(state.courses, course)}"></span>
            <div><h2>${course || 'Sin asignatura'}</h2><div class="meta">${items.length} clases · ${duration(info.totalSeconds)}</div></div>
            <div class="meter" role="group" aria-label="Clases con apuntes">
              <div class="meter-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
              <small>${done} de ${items.length} con apuntes</small></div>
          </div>
          <table><thead><tr><th>Clase</th><th class="hide-sm">Fecha</th><th class="hide-sm">Duración</th><th>Material</th><th>Estado</th><th></th></tr></thead>
            <tbody>${items.map(row)}</tbody></table>
        </section>`;
      })}
  `);

  const doIngest = async (btn) => {
    btn.disabled = true;
    try {
      const { result } = await api('/api/ingest', { method: 'POST', body: {} });
      toast(`Importadas ${result.created + result.linked} clases · ${result.importedNotes} apuntes`);
      await refreshMeta(); await renderRoute();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  };
  root.querySelector('#ingest-btn')?.addEventListener('click', (e) => doIngest(e.currentTarget));
  root.querySelector('#ingest-btn-2')?.addEventListener('click', (e) => doIngest(e.currentTarget));
  root.querySelector('[data-clear-course]')?.addEventListener('click', () => import('../main.js').then((m) => m.setCourse('')));
  root.querySelectorAll('.filter-btn').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; renderRoute(); }));
  root.querySelectorAll('[data-process]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '⏳ Procesando…';
    try {
      const { report } = await api(`/api/recordings/${b.dataset.process}/process`, { method: 'POST', body: {} });
      toast(report.errors.length ? report.errors[0] : `Listo: ${report.alerts} avisos · ${report.flashcards} tarjetas`, report.errors.length ? 'err' : 'ok');
      await refreshMeta(); await renderRoute();
    } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = '✨ Generar con IA'; }
  }));
  void go; void esc;
}
