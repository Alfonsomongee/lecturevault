// Alert row + actions shared by the agenda and the recording page.
import { api, html, icon, kindChip, msClock, fmtDate, relativeDay, daysUntil, toast, confirmDialog } from '../util.js';

/** `inline` = the page already hosts the player, so "listen" is a button handled by the page. */
export function alertCard(a, { withSource = true, inline = false } = {}) {
  const late = a.due_date && !a.dismissed && daysUntil(a.due_date) < 0;
  return html`<div class="item ${a.dismissed ? 'is-done' : ''}" data-aid="${a.id}" id="alert-${a.id}">
    <div class="body">
      <div class="tags">${kindChip(a.kind)}
        ${a.due_date ? html`<span class="tag ${late ? 'tag-red' : ''}">${fmtDate(a.due_date)}</span><span class="muted small">${relativeDay(a.due_date)}</span>` : html`<span class="muted small">Sin fecha</span>`}
        ${a.source === 'manual' ? html`<span class="tag">Manual</span>` : a.confirmed ? html`<span class="tag tag-green">Confirmado</span>` : a.confidence === 'low' ? html`<span class="tag tag-red">Dudoso</span>` : ''}
        ${a.dismissed ? html`<span class="muted small">Descartado</span>` : ''}</div>
      <div class="txt" style="margin-top:4px">${a.text}</div>
      ${a.quote ? html`<q>${a.quote}</q>` : ''}
      <div class="meta">
        ${withSource ? html`<span>${a.course ? `${a.course.split(' ')[0]} · ` : ''}${a.recording_title || ''}</span>` : ''}
        ${inline ? html`<button class="btn sm" data-act="listen" type="button">${icon('play', 12)} ${msClock(a.t_ms)}</button>`
          : html`<a class="btn sm" href="#/r/${a.recording_id}?t=${Math.max(0, Math.floor(a.t_ms / 1000) - 3)}">${icon('play', 12)} Escuchar ${msClock(a.t_ms)}</a>`}
      </div>
    </div>
    <div class="acts">
      ${a.dismissed ? html`<button class="btn sm" data-act="restore" type="button">Restaurar</button>`
        : html`<button class="btn sm" data-act="confirm" type="button">${a.confirmed ? 'Quitar confirmación' : 'Confirmar'}</button>
               <button class="btn sm ghost" data-act="dismiss" type="button">Descartar</button>`}
      ${a.source === 'manual' ? html`<button class="btn sm ghost icon" data-act="delete" type="button" aria-label="Borrar aviso" title="Borrar">${icon('trash', 14)}</button>` : ''}
      <label class="sr-only" for="d${a.id}">Fecha</label>
      <input class="input" id="d${a.id}" data-act="date" type="date" value="${a.due_date || ''}" style="height:24px;font-size:12.5px">
    </div>
  </div>`;
}

/** Wire confirm / dismiss / restore / delete / date edits. `onChange` re-renders; `onListen` seeks. */
export function bindAlertActions(container, alerts, onChange, onListen) {
  const find = (el) => alerts.find((x) => x.id === Number(el.closest('[data-aid]')?.dataset.aid));
  container.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]');
    if (!act) return;
    const a = find(act);
    if (!a) return;
    if (act.dataset.act === 'listen') { onListen?.(a); return; }
    try {
      if (act.dataset.act === 'delete') {
        if (!(await confirmDialog('Borrar este aviso', { confirm: 'Borrar', danger: true }))) return;
        await api(`/api/alerts/${a.id}`, { method: 'DELETE' });
        alerts.splice(alerts.indexOf(a), 1);
      } else {
        const patch = { confirm: { confirmed: !a.confirmed }, dismiss: { dismissed: true }, restore: { dismissed: false } }[act.dataset.act];
        Object.assign(a, (await api(`/api/alerts/${a.id}`, { method: 'PATCH', body: patch })).alert);
      }
      onChange();
    } catch (err) { toast(err.message, 'err'); }
  });
  container.addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'date') return;
    const a = find(e.target);
    try {
      Object.assign(a, (await api(`/api/alerts/${a.id}`, { method: 'PATCH', body: { due_date: e.target.value || null, confirmed: !!e.target.value } })).alert);
      toast('Fecha guardada');
      onChange();
    } catch (err) { toast(err.message, 'err'); }
  });
}
