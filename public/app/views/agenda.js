// Agenda: month calendar + dated deadlines + "keep in mind" warnings, with .ics export.
import { api, html, mount, KINDS, kindChip, fmtDate, daysUntil, relativeDay, isoParts } from '../util.js';
import { state, refreshMeta } from '../main.js';
import { alertCard, bindAlertActions } from './alerts-ui.js';

let monthOffset = 0;
let showDone = false;

const pad = (n) => String(n).padStart(2, '0');
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export async function renderAgenda(root) {
  const qs = state.course ? `?course=${encodeURIComponent(state.course)}` : '';
  const { alerts } = await api(`/api/alerts${qs}`);

  const draw = () => {
    const live = alerts.filter((a) => showDone || !a.dismissed);
    const dated = live.filter((a) => a.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.t_ms - b.t_ms);
    const undated = live.filter((a) => !a.due_date);

    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    const first = (base.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < Math.ceil((first + daysInMonth) / 7) * 7; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), 1 - first + i);
      cells.push({ d, iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, other: d.getMonth() !== base.getMonth() });
    }
    const byDay = new Map();
    for (const a of dated) { if (!byDay.has(a.due_date)) byDay.set(a.due_date, []); byDay.get(a.due_date).push(a); }
    const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    const groups = new Map();
    for (const a of dated) {
      const { date } = isoParts(a.due_date);
      const key = date.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const undatedByCourse = new Map();
    for (const a of undated) {
      const k = a.course || 'Sin asignatura';
      if (!undatedByCourse.has(k)) undatedByCourse.set(k, []);
      undatedByCourse.get(k).push(a);
    }
    const q = state.course ? `?course=${encodeURIComponent(state.course)}` : '';

    mount(root, html`
      <div class="page-head">
        <div><div class="eyebrow">Lo que dijo el profesor</div><h1>Agenda y avisos críticos</h1>
          <p>Fechas, exámenes y advertencias extraídos de tus clases. Confirma los dudosos escuchando el momento exacto antes de exportarlos.</p></div>
        <div class="chip-row">
          <a class="btn primary" href="/api/calendar.ics${q}" download>📅 Exportar .ics</a>
          <a class="btn" href="/api/calendar.ics${q}${q ? '&' : '?'}confirmed=1" download title="Solo las fechas que confirmaste">✓ Solo confirmadas</a>
          <label class="follow"><input type="checkbox" id="show-done" ${showDone ? 'checked' : ''}> Mostrar descartados</label>
        </div>
      </div>

      ${live.length === 0 ? html`<div class="card empty-state"><div class="icon">🗓️</div><h2>Sin avisos todavía</h2>
        <p>Cuando proceses una clase con IA, aquí aparecerán entregas, exámenes y advertencias con su minuto exacto.</p></div>` : html`
      <div class="agenda-grid">
        <section class="card cal" aria-label="Calendario">
          <div class="cal-head">
            <h2>${cap(base.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }))}</h2>
            <button class="btn sm" id="prev" type="button" aria-label="Mes anterior">‹</button>
            <button class="btn sm" id="now" type="button">Hoy</button>
            <button class="btn sm" id="next" type="button" aria-label="Mes siguiente">›</button>
          </div>
          <div class="cal-grid">
            ${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => html`<div class="cal-dow">${d}</div>`)}
            ${cells.map((c) => html`<div class="cal-day ${c.other ? 'other' : ''} ${c.iso === todayIso ? 'today' : ''}">
              <b>${c.d.getDate()}</b>
              ${(byDay.get(c.iso) || []).slice(0, 3).map((a) => html`<button class="cal-ev" type="button" data-jump="${a.id}" style="--c:${(KINDS[a.kind] || {}).color || 'var(--muted)'}" title="${a.text}">${(KINDS[a.kind] || {}).icon} ${a.text}</button>`)}
              ${(byDay.get(c.iso) || []).length > 3 ? html`<span class="sub">+${byDay.get(c.iso).length - 3}</span>` : ''}
            </div>`)}
          </div>
          <div class="chip-row" style="margin-top:12px">${Object.keys(KINDS).map((k) => kindChip(k))}</div>
        </section>

        <div id="lists">
          ${dated.length ? html`<section class="card" style="margin-bottom:16px"><h2 class="section-title" style="padding:16px 16px 0">Con fecha</h2>
            ${[...groups.entries()].map(([month, items]) => html`<div class="agenda-day">${cap(month)}</div>${items.map((a) => alertCard(a))}`)}</section>` : ''}
          ${undated.length ? html`<section class="card"><h2 class="section-title" style="padding:16px 16px 0">Para tener en cuenta</h2>
            ${[...undatedByCourse.entries()].map(([course, items]) => html`<div class="agenda-day">${course}</div>${items.map((a) => alertCard(a, { withSource: false }))}`)}</section>` : ''}
        </div>
      </div>`}
    `);

    root.querySelector('#show-done')?.addEventListener('change', (e) => { showDone = e.target.checked; draw(); });
    root.querySelector('#prev')?.addEventListener('click', () => { monthOffset--; draw(); });
    root.querySelector('#next')?.addEventListener('click', () => { monthOffset++; draw(); });
    root.querySelector('#now')?.addEventListener('click', () => { monthOffset = 0; draw(); });
    root.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
      const el = root.querySelector(`#alert-${b.dataset.jump}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.animate([{ background: 'var(--accent-soft)' }, { background: 'transparent' }], { duration: 1400 });
    }));
  };

  draw();
  // Delegated once on the root so redraws don't stack listeners
  bindAlertActions(root, alerts, () => { draw(); refreshMeta().catch(() => {}); });
  void fmtDate; void daysUntil; void relativeDay;
}
