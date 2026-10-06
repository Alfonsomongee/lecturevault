// Repaso: repetición espaciada (cajas de Leitner) y gestión de todas las tarjetas.
import { api, html, mount, icon, richText, msClock, toast, isTyping, confirmDialog } from '../util.js';
import { state, refreshMeta, onLeave } from '../main.js';

const BOX_LABELS = ['Hoy', '1 día', '3 días', '7 días', '21 días'];
let practice = false;
let section = 'session';
let renderToken = 0; // un render más nuevo anula a los lentos (clics rápidos)
let activeKeys = null;

export async function renderStudy(root) {
  const token = ++renderToken;
  const course = state.course ? `course=${encodeURIComponent(state.course)}&` : '';
  const [dueData, allData] = await Promise.all([api(`/api/flashcards?${course}due=1`), api(`/api/flashcards?${course}`)]);
  if (token !== renderToken) return;
  const all = allData.flashcards;
  const queue = practice ? [...all].sort(() => Math.random() - 0.5) : dueData.flashcards;
  let i = 0, revealed = false, right = 0, wrong = 0;
  const total = queue.length;
  const boxes = BOX_LABELS.map((label, b) => ({ label, n: all.filter((c) => c.box === b).length }));
  const maxBox = Math.max(1, ...boxes.map((b) => b.n));
  const qExport = state.course ? `&course=${encodeURIComponent(state.course)}` : '';

  const drawSession = () => {
    const card = queue[i];
    if (all.length === 0) return html`<div class="empty"><h3>Aún no hay tarjetas</h3><p>Se generan al procesar una clase con IA, o puedes crearlas a mano desde la pestaña Tarjetas de cada clase.</p></div>`;
    if (i >= queue.length) return html`<div class="empty"><h3>${total ? 'Sesión completada' : 'No hay tarjetas pendientes'}</h3>
      <p>${total ? `${right} recordadas, ${wrong} para volver a ver hoy.` : 'Estás al día. Vuelve mañana o practica todas.'}</p>
      ${total ? '' : html`<button class="btn" id="practice-now" type="button">Practicar todas</button>`}</div>`;
    return html`<div class="review">
      <div class="progress" role="progressbar" aria-valuenow="${i}" aria-valuemin="0" aria-valuemax="${queue.length}"><i style="width:${(i / queue.length) * 100}%"></i></div>
      <div class="muted small" style="display:flex;justify-content:space-between;margin-bottom:8px"><span>${i + 1} de ${queue.length}</span><span>${right} bien, ${wrong} mal</span></div>
      <button class="flashcard" id="card" type="button" aria-live="polite">
        <span class="side">${card.kind === 'cloze' ? 'Completa el hueco' : revealed ? 'Respuesta' : 'Pregunta'}</span>
        <span class="face">${richText(card.front, { reveal: card.kind === 'cloze' && revealed })}</span>
        ${revealed && card.back ? html`<span class="answer">${richText(card.back)}</span>` : ''}
        ${revealed ? '' : html`<span class="muted small">Pulsa para ver la respuesta</span>`}
      </button>
      <div class="review-actions">
        ${revealed ? html`<button class="btn" id="again" type="button"><kbd>1</kbd> Otra vez</button><button class="btn primary" id="good" type="button"><kbd>2</kbd> Lo sabía</button>`
          : html`<button class="btn primary" id="reveal" type="button">Mostrar respuesta <kbd>Espacio</kbd></button>`}
      </div>
      <p class="muted small" style="text-align:center;margin-top:12px"><a href="#/r/${card.recording_id}?t=${Math.max(0, Math.floor(card.t_ms / 1000) - 2)}" style="text-decoration:underline">${card.recording_title}, ${msClock(card.t_ms)}</a>${card.tag ? ` · ${card.tag}` : ''}</p>
    </div>`;
  };

  const drawList = () => all.length ? html`<table class="db"><thead><tr><th>Tarjeta</th><th class="hide-sm">Clase</th><th class="hide-sm">Caja</th><th></th></tr></thead><tbody>
    ${all.map((c) => html`<tr data-cid="${c.id}"><td class="name"><a href="#/r/${c.recording_id}?tab=cards">${richText(c.front)}</a><div class="muted small">${c.kind === 'cloze' ? 'Cloze' : richText(c.back)}</div></td>
      <td class="hide-sm muted small">${c.recording_title}</td><td class="hide-sm muted small">${BOX_LABELS[c.box] || c.box}</td>
      <td class="acts"><button class="btn sm ghost row-acts" data-del type="button" aria-label="Eliminar">${icon('trash', 14)}</button></td></tr>`)}</tbody></table>`
    : html`<div class="empty"><p>No hay tarjetas.</p></div>`;

  const draw = () => {
    mount(root, html`
      <h1 class="page-title">Repaso</h1>
      <p class="page-sub">${practice ? 'Modo práctica: no cambia tu calendario de repaso.' : 'Las tarjetas que dominas vuelven cada vez más tarde; las que fallas, hoy mismo.'}</p>
      <div class="toolbar">
        <div class="seg-ctl" role="group" aria-label="Sección"><button type="button" data-sec="session" aria-pressed="${section === 'session'}">Sesión</button><button type="button" data-sec="all" aria-pressed="${section === 'all'}">Todas (${all.length})</button></div>
        <span class="spacer"></span>
        <button class="btn" id="mode" type="button">${practice ? 'Volver al repaso del día' : 'Practicar todas'}</button>
        <a class="btn" href="/api/export/anki?kind=basic${qExport}" download>${icon('download', 14)} Anki básicas</a>
        <a class="btn" href="/api/export/anki?kind=cloze${qExport}" download>${icon('download', 14)} Anki cloze</a>
      </div>
      ${section === 'session' ? html`${drawSession()}
        <h2 class="section">Dominio</h2>
        <div class="boxes">${boxes.map((b) => html`<span>${b.label}</span><span class="bar"><i style="width:${(b.n / maxBox) * 100}%"></i></span><span class="v">${b.n}</span>`)}</div>
        <p class="muted small" style="margin-top:12px">Atajos: <kbd>Espacio</kbd> mostrar, <kbd>1</kbd> otra vez, <kbd>2</kbd> lo sabía.</p>` : drawList()}
    `);
    root.querySelectorAll('[data-sec]').forEach((b) => b.addEventListener('click', () => { section = b.dataset.sec; draw(); }));
    root.querySelector('#mode').addEventListener('click', () => { practice = !practice; renderStudy(root); });
    root.querySelector('#practice-now')?.addEventListener('click', () => { practice = true; renderStudy(root); });
    root.querySelector('#card')?.addEventListener('click', () => { revealed = true; draw(); });
    root.querySelector('#reveal')?.addEventListener('click', () => { revealed = true; draw(); });
    root.querySelector('#again')?.addEventListener('click', () => answer(false));
    root.querySelector('#good')?.addEventListener('click', () => answer(true));
    root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.closest('[data-cid]').dataset.cid);
      if (!(await confirmDialog('Eliminar esta tarjeta', { confirm: 'Eliminar', danger: true }))) return;
      try { await api(`/api/flashcards/${id}`, { method: 'DELETE' }); await refreshMeta(); renderStudy(root); }
      catch (err) { toast(err.message, 'err'); }
    }));
  };

  const answer = async (correct) => {
    const card = queue[i];
    if (!card) return;
    if (correct) right++; else wrong++;
    if (!practice) {
      try { await api(`/api/flashcards/${card.id}/review`, { method: 'POST', body: { correct } }); }
      catch (err) { toast(err.message, 'err'); }
    }
    i++; revealed = false;
    if (i >= queue.length) refreshMeta().catch(() => {});
    draw();
  };

  const keys = (e) => {
    if (isTyping() || e.ctrlKey || e.metaKey || section !== 'session' || i >= queue.length) return;
    if ((e.key === ' ' || e.key === 'Enter') && !revealed) { e.preventDefault(); revealed = true; draw(); }
    else if (revealed && e.key === '1') answer(false);
    else if (revealed && e.key === '2') answer(true);
  };
  if (activeKeys) removeEventListener('keydown', activeKeys);
  activeKeys = keys;
  addEventListener('keydown', keys);
  onLeave(() => { removeEventListener('keydown', keys); if (activeKeys === keys) activeKeys = null; });
  draw();
}
