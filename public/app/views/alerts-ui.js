// Shared alert card + actions (used by the agenda).
import { api, html, kindChip, msClock, fmtDate, relativeDay, toast } from '../util.js';

export function alertCard(a, { withSource = true } = {}) {
  return html`<div class="alert ${a.dismissed ? 'is-done' : ''}" data-aid="${a.id}" id="alert-${a.id}">
    <div class="body">
      <div class="chip-row">${kindChip(a.kind)}
        ${a.due_date ? html`<span class="badge">📅 ${fmtDate(a.due_date)} · ${relativeDay(a.due_date)}</span>` : html`<span class="badge off">Sin fecha</span>`}
        ${a.confirmed ? html`<span class="tick">✓ Confirmado</span>` : a.confidence === 'low' ? html`<span class="conf-low">⚠ Dudoso: verifica con el audio</span>` : ''}
        ${a.dismissed ? html`<span class="sub">Descartado</span>` : ''}</div>
      <div class="txt">${a.text}</div>
      ${a.quote ? html`<q>${a.quote}</q>` : ''}
      ${withSource ? html`<div class="sub" style="margin-top:4px">${a.course ? `${a.course} · ` : ''}${a.recording_title || ''}</div>` : ''}
      <div class="acts">
        <a class="btn sm" href="#/r/${a.recording_id}?t=${Math.max(0, Math.floor(a.t_ms / 1000) - 3)}">▶ Escuchar ${msClock(a.t_ms)}</a>
        ${a.dismissed ? html`<button class="btn sm" data-act="restore" type="button">Restaurar</button>`
          : html`<button class="btn sm" data-act="confirm" type="button">${a.confirmed ? '↩ Quitar confirmación' : '✓ Confirmar'}</button>
                 <button class="btn sm ghost" data-act="dismiss" type="button">✕ Descartar</button>`}
        <label class="sr-only" for="d${a.id}">Fecha</label>
        <input class="input" id="d${a.id}" data-act="date" type="date" value="${a.due_date || ''}" style="padding:4px 8px;font-size:13px">
      </div>
    </div>
  </div>`;
}

/** Wire confirm / dismiss / restore / date edits on a container. `onChange` re-renders. */
export function bindAlertActions(container, alerts, onChange) {
  const find = (el) => alerts.find((x) => x.id === Number(el.closest('[data-aid]')?.dataset.aid));
  container.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]');
    if (!act) return;
    const a = find(act);
    if (!a) return;
    const patch = { confirm: { confirmed: !a.confirmed }, dismiss: { dismissed: true }, restore: { dismissed: false } }[act.dataset.act];
    try {
      Object.assign(a, (await api(`/api/alerts/${a.id}`, { method: 'PATCH', body: patch })).alert);
      onChange();
    } catch (err) { toast(err.message, 'err'); }
  });
  container.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'date') return;
    const a = find(e.target);
    try {
      Object.assign(a, (await api(`/api/alerts/${a.id}`, { method: 'PATCH', body: { due_date: e.target.value || null, confirmed: !!e.target.value } })).alert);
      toast('Fecha actualizada y confirmada');
      onChange();
    } catch (err) { toast(err.message, 'err'); }
  });
}
