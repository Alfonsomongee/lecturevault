// Study: spaced-repetition review (Leitner boxes) with cloze support and Anki export.
import { api, html, raw, mount, richText, msClock, toast } from '../util.js';
import { state, refreshMeta, onLeave } from '../main.js';

const BOX_LABELS = ['Hoy', '1 día', '3 días', '7 días', '21 días'];
let practice = false;

export async function renderStudy(root) {
  const qs = (extra = '') => `?${state.course ? `course=${encodeURIComponent(state.course)}&` : ''}${extra}`;
  const [dueData, allData] = await Promise.all([api(`/api/flashcards${qs('due=1')}`), api(`/api/flashcards${qs()}`)]);
  const all = allData.flashcards;
  let queue = practice ? [...all].sort(() => Math.random() - 0.5) : dueData.flashcards;
  let i = 0, revealed = false, right = 0, wrong = 0;
  const total = queue.length;

  const boxes = BOX_LABELS.map((label, b) => ({ label, n: all.filter((c) => c.box === b).length }));
  const maxBox = Math.max(1, ...boxes.map((b) => b.n));
  const qExport = state.course ? `&course=${encodeURIComponent(state.course)}` : '';

  const draw = () => {
    const card = queue[i];
    const done = i >= queue.length;
    mount(root, html`
      <div class="page-head"><div><div class="eyebrow">Repetición espaciada</div><h1>Estudiar</h1>
        <p>${practice ? 'Modo práctica: no cambia tu calendario de repaso.' : 'Las tarjetas que dominas vuelven cada vez más tarde; las que fallas, hoy mismo.'}</p></div>
        <div class="chip-row">
          <button class="btn" id="mode" type="button">${practice ? '↩ Volver al repaso del día' : '🔀 Practicar todas'}</button>
          <a class="btn" href="/api/export/anki?kind=basic${qExport}" download>⬇ Anki (básicas)</a>
          <a class="btn" href="/api/export/anki?kind=cloze${qExport}" download>⬇ Anki (cloze)</a></div></div>
      <div class="study-grid">
        <section class="card flash-wrap" aria-label="Sesión de repaso">
          ${all.length === 0 ? html`<div class="empty-state"><div class="icon">🃏</div><h2>Aún no hay tarjetas</h2>
              <p>Se generan automáticamente al procesar una clase con IA (15–20 por sesión, con la cita que las respalda).</p></div>`
          : done ? html`<div class="empty-state"><div class="icon">${total ? '🎉' : '✅'}</div>
              <h2>${total ? '¡Sesión completada!' : 'Estás al día'}</h2>
              <p>${total ? `${right} recordadas · ${wrong} para repasar hoy otra vez.` : 'No tienes tarjetas pendientes. Vuelve mañana o practica todas.'}</p>
              ${total ? '' : html`<button class="btn primary" id="practice-now" type="button">🔀 Practicar todas</button>`}</div>`
          : html`
            <div class="flash-progress"><span>${i + 1} / ${queue.length}</span>
              <div class="meter-bar" role="progressbar" aria-valuenow="${i}" aria-valuemin="0" aria-valuemax="${queue.length}"><i style="width:${(i / queue.length) * 100}%"></i></div>
              <span>${right} ✓ · ${wrong} ✗</span></div>
            <button class="flashcard" id="card" type="button" aria-live="polite">
              <span class="side">${card.kind === 'cloze' ? 'Completa el hueco' : revealed ? 'Respuesta' : 'Pregunta'}</span>
              <span class="face">${richText(card.front, { reveal: card.kind === 'cloze' && revealed })}</span>
              ${revealed && card.kind === 'basic' ? html`<span class="answer">${richText(card.back)}</span>` : ''}
              ${revealed && card.kind === 'cloze' && card.back ? html`<span class="answer">${richText(card.back)}</span>` : ''}
              ${revealed ? '' : html`<span class="sub">Pulsa para ver la respuesta (Espacio)</span>`}
            </button>
            <div class="flash-actions">
              ${revealed ? html`<button class="btn" id="again" type="button" style="min-width:150px"><kbd>1</kbd> Otra vez</button>
                <button class="btn primary" id="good" type="button" style="min-width:150px"><kbd>2</kbd> Lo sabía</button>`
                : html`<button class="btn primary" id="reveal" type="button" style="min-width:200px">Mostrar respuesta</button>`}
            </div>
            <div class="flash-src"><a href="#/r/${card.recording_id}?t=${Math.max(0, Math.floor(card.t_ms / 1000) - 2)}">🎧 ${card.recording_title} · ${msClock(card.t_ms)}</a>
              ${card.tag ? ` · #${card.tag}` : ''}</div>`}
        </section>
        <aside class="card card-pad" aria-label="Dominio">
          <h2 class="section-title">Dominio de tus tarjetas</h2>
          <p class="sub" style="margin-bottom:12px">${all.length} tarjetas · cada caja es el intervalo hasta el próximo repaso</p>
          <div class="boxes">${boxes.map((b, k) => html`<div class="box-row">
            <span>${b.label}</span>
            <div class="meter-bar"><i style="width:${(b.n / maxBox) * 100}%;--b:color-mix(in srgb, var(--accent-fill) ${35 + k * 16}%, var(--surface-2))"></i></div>
            <span class="v">${b.n}</span></div>`)}</div>
          <p class="sub" style="margin-top:14px">Atajos: <kbd>Espacio</kbd> mostrar · <kbd>1</kbd> otra vez · <kbd>2</kbd> lo sabía</p>
        </aside>
      </div>`);

    root.querySelector('#mode')?.addEventListener('click', () => { practice = !practice; renderStudy(root); });
    root.querySelector('#practice-now')?.addEventListener('click', () => { practice = true; renderStudy(root); });
    root.querySelector('#card')?.addEventListener('click', () => { revealed = true; draw(); });
    root.querySelector('#reveal')?.addEventListener('click', () => { revealed = true; draw(); });
    root.querySelector('#again')?.addEventListener('click', () => answer(false));
    root.querySelector('#good')?.addEventListener('click', () => answer(true));
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
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || e.ctrlKey || e.metaKey) return;
    if (i >= queue.length) return;
    if ((e.key === ' ' || e.key === 'Enter') && !revealed) { e.preventDefault(); revealed = true; draw(); }
    else if (revealed && e.key === '1') answer(false);
    else if (revealed && e.key === '2') answer(true);
  };
  addEventListener('keydown', keys);
  onLeave(() => removeEventListener('keydown', keys));
  draw();
  void raw;
}
