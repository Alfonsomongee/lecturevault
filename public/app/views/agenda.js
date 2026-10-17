// Agenda: lista de fechas y avisos, calendario mensual, alta manual y exportación .ics.
import { api, html, mount, icon, KINDS, isoParts, isoLocal, courseLabel, toast } from '../util.js';
import { state, refreshMeta } from '../main.js';
import { alertCard, bindAlertActions } from './alerts-ui.js';

let monthOffset = 0;
let showDone = false;
let mode = 'list';
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export async function renderAgenda(root) {
  const qs = state.course ? `?course=${encodeURIComponent(state.course)}` : '';
  const [{ alerts }, lib] = await Promise.all([api(`/api/alerts${qs}`), api(`/api/recordings${qs}`)]);
  const recordings = lib.recordings.filter((r) => r.segment_count > 0);

  const draw = () => {
    const live = alerts.filter((a) => showDone || !a.dismissed);
    const dated = live.filter((a) => a.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.t_ms - b.t_ms);
    const undated = live.filter((a) => !a.due_date);

    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    const first = (base.getDay() + 6) % 7;
    const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < Math.ceil((first + daysInMonth) / 7) * 7; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), 1 - first + i);
      cells.push({ d, iso: isoLocal(d), other: d.getMonth() !== base.getMonth() });
    }
    const byDay = new Map();
    for (const a of dated) { if (!byDay.has(a.due_date)) byDay.set(a.due_date, []); byDay.get(a.due_date).push(a); }
    const todayIso = isoLocal(today);

    const groups = new Map();
    for (const a of dated) {
      const key = cap(isoParts(a.due_date).date.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const undatedByCourse = new Map();
    for (const a of undated) {
      const k = a.course ? courseLabel(a.course) : 'Sin asignatura';
      if (!undatedByCourse.has(k)) undatedByCourse.set(k, []);
      undatedByCourse.get(k).push(a);
    }

    mount(root, html`
      <h1 class="page-title">Agenda</h1>
      <p class="page-sub">Fechas, exámenes y advertencias que dijo el profesor. Escucha el momento y confirma los dudosos antes de exportarlos al calendario.</p>
      <div class="toolbar">
        <div class="seg-ctl" role="group" aria-label="Vista"><button type="button" data-mode="list" aria-pressed="${mode === 'list'}">Lista</button><button type="button" data-mode="cal" aria-pressed="${mode === 'cal'}">Calendario</button></div>
        <label class="follow"><input type="checkbox" id="show-done" ${showDone ? html`checked` : ''}> Mostrar descartados</label>
        <span class="spacer"></span>
        <button class="btn" id="new-alert" type="button">${icon('plus', 14)} Nuevo aviso</button>
        <a class="btn" href="/api/calendar.ics${qs}${qs ? '&' : '?'}confirmed=1" download title="Solo las fechas que confirmaste">${icon('download', 14)} .ics confirmadas</a>
        <a class="btn" href="/api/calendar.ics${qs}" download>${icon('download', 14)} .ics todas</a>
      </div>
      <div id="alert-form"></div>

      ${live.length === 0 ? html`<div class="empty"><h3>Sin avisos</h3><p>Al procesar una clase con IA aparecerán aquí entregas, exámenes y advertencias con su minuto exacto. También puedes añadirlos a mano.</p></div>`
      : mode === 'cal' ? html`
        <div class="cal-head"><h2>${cap(base.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }))}</h2>
          <button class="btn sm icon" id="prev" type="button" aria-label="Mes anterior">${icon('chevron', 14)}</button>
          <button class="btn sm" id="now" type="button">Hoy</button>
          <button class="btn sm icon" id="next" type="button" aria-label="Mes siguiente">${icon('chevron', 14)}</button></div>
        <div class="cal-grid">
          ${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => html`<div class="cal-dow">${d}</div>`)}
          ${cells.map((c) => html`<div class="cal-day ${c.other ? 'other' : ''} ${c.iso === todayIso ? 'today' : ''}"><b>${c.d.getDate()}</b>
            ${(byDay.get(c.iso) || []).slice(0, 3).map((a) => { const k = KINDS[a.kind] || { tag: 'gray' };
              return html`<button class="cal-ev" type="button" data-jump="${a.id}" style="--ev-bg:var(--tag-${k.tag}-bg);--ev-fg:var(--tag-${k.tag}-fg)" title="${a.text}">${a.text}</button>`; })}
            ${(byDay.get(c.iso) || []).length > 3 ? html`<span class="muted small">+${byDay.get(c.iso).length - 3}</span>` : ''}</div>`)}
        </div>
        <div id="detail" style="margin-top:20px"></div>`
      : html`
        ${[...groups.entries()].map(([month, items]) => html`<h2 class="section">${month}</h2>${items.map((a) => alertCard(a))}`)}
        ${[...undatedByCourse.entries()].map(([course, items]) => html`<h2 class="section">Sin fecha · ${course}</h2>${items.map((a) => alertCard(a, { withSource: false }))}`)}`}
    `);

    root.querySelector('#show-done')?.addEventListener('change', (e) => { showDone = e.target.checked; draw(); });
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; draw(); }));
    root.querySelector('#prev')?.addEventListener('click', () => { monthOffset--; draw(); });
    root.querySelector('#next')?.addEventListener('click', () => { monthOffset++; draw(); });
    root.querySelector('#now')?.addEventListener('click', () => { monthOffset = 0; draw(); });
    root.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
      const a = alerts.find((x) => x.id === Number(b.dataset.jump));
      mount(root.querySelector('#detail'), alertCard(a));
    }));
    root.querySelector('#new-alert').addEventListener('click', () => {
      mount(root.querySelector('#alert-form'), html`<form class="form-row" id="alert-new">
        <div class="field"><label for="na-rec">Clase</label><select class="input" id="na-rec" required>${recordings.map((r) => html`<option value="${r.id}">${r.title}</option>`)}</select></div>
        <div class="field"><label for="na-kind">Tipo</label><select class="input" id="na-kind">${Object.entries(KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></div>
        <div class="field grow"><label for="na-text">Texto</label><input class="input" id="na-text" maxlength="400" required></div>
        <div class="field"><label for="na-date">Fecha</label><input class="input" id="na-date" type="date"></div>
        <button class="btn primary" type="submit">Añadir</button><button class="btn" type="button" id="na-cancel">Cancelar</button></form>`);
      root.querySelector('#na-text').focus();
    });
    root.querySelector('#alert-form').addEventListener('click', (e) => { if (e.target.id === 'na-cancel') root.querySelector('#alert-form').innerHTML = ''; });
    root.querySelector('#alert-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { alert } = await api(`/api/recordings/${root.querySelector('#na-rec').value}/alerts`, {
          method: 'POST', body: { kind: root.querySelector('#na-kind').value, text: root.querySelector('#na-text').value, due_date: root.querySelector('#na-date').value || null },
        });
        const rec = recordings.find((r) => r.id === alert.recording_id);
        alerts.push({ ...alert, recording_title: rec?.title, course: rec?.course });
        toast('Aviso añadido'); draw(); refreshMeta().catch(() => {});
      } catch (err) { toast(err.message, 'err'); }
    });
  };

  draw();
  bindAlertActions(root, alerts, () => { draw(); refreshMeta().catch(() => {}); });
}
