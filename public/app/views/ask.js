// Preguntar: respuestas con citas literales verificadas y enlace al minuto.
import { api, html, mount, renderMarkdown, msClock, toast, courseLabel } from '../util.js';
import { state } from '../main.js';

const history = [];
const SUGGESTIONS = ['¿Qué entra en el examen?', '¿Qué peso tiene cada práctica y cuándo se entrega?', '¿Qué fórmulas marcó el profesor como importantes?'];

export async function renderAsk(root, params) {
  mount(root, html`
    <h1 class="page-title">Preguntar</h1>
    <p class="page-sub">Responde solo con lo que se dijo en tus clases y muestra la cita literal con su minuto. ${state.ai ? '' : 'Sin clave de Gemini se muestran los fragmentos más relevantes en lugar de una respuesta redactada.'}${state.course ? ` Limitado a ${courseLabel(state.course)}.` : ''}</p>
    <div class="chat" id="chat" aria-live="polite"></div>
    <div class="ask-bar"><form id="ask-form" autocomplete="off">
      <label class="sr-only" for="ask-input">Pregunta</label>
      <input class="input" id="ask-input" placeholder="Escribe tu pregunta" maxlength="500">
      <button class="btn primary" type="submit">Preguntar</button></form></div>`);

  const chat = root.querySelector('#chat');
  const input = root.querySelector('#ask-input');
  const link = (recordingId, ms) => `#/r/${recordingId}?t=${Math.max(0, Math.floor(ms / 1000) - 2)}`;

  const draw = () => {
    if (history.length === 0) {
      mount(chat, html`<div class="suggest">${SUGGESTIONS.map((s) => html`<button type="button" data-s="${s}">${s}</button>`)}</div>`);
      return;
    }
    mount(chat, html`${history.map((m, idx) => m.q !== undefined ? html`<div class="q-msg">${m.q}</div>` : m.pending ? html`<div class="typing">Buscando en tus clases…</div>`
      : html`<div class="a-msg" data-i="${idx}">${m.error ? html`<p class="warn">${m.error}</p>` : html`<div class="prose answer"></div>
        ${m.res.citations.map((c) => html`<button class="cite" type="button" data-go="${link(c.recordingId, c.startMs)}"><span class="cite-id">${c.fragment}, ${msClock(c.startMs)}</span><span><b>${c.recordingTitle}</b><q>${c.quote}</q></span></button>`)}
        ${m.res.answer === null || !m.res.found ? html`<h2 class="section" style="margin-top:14px">Fragmentos relevantes</h2>
          ${m.res.sources.slice(0, 4).map((s) => html`<button class="cite" type="button" data-go="${link(s.recordingId, s.startMs)}"><span class="cite-id">${msClock(s.startMs)}</span><span><b>${s.recordingTitle}</b><q>${s.text.slice(0, 240)}${s.text.length > 240 ? '…' : ''}</q></span></button>`)}` : ''}
        <p class="muted small" style="margin-top:8px">${m.res.mode === 'hybrid' ? 'Búsqueda por palabras y por significado' : 'Búsqueda por palabras clave'}, ${m.res.sources.length} fragmentos consultados.</p>`}</div>`)}`);
    chat.querySelectorAll('.a-msg[data-i]').forEach((el) => {
      const m = history[Number(el.dataset.i)];
      const body = el.querySelector('.answer');
      if (!body || !m.res.answer) { body?.remove(); return; }
      const rendered = renderMarkdown(m.res.answer, { timestamps: false });
      rendered.innerHTML = rendered.innerHTML.replace(/\[F(\d+)\]/g, (_, n) => `<button type="button" class="ts" data-f="${Number(n)}">F${Number(n)}</button>`);
      body.replaceChildren(...rendered.childNodes);
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-f]');
        const c = b && m.res.citations.find((x) => x.fragment === `F${b.dataset.f}`);
        if (c) location.hash = link(c.recordingId, c.startMs);
      });
    });
    input.scrollIntoView({ block: 'end' });
  };

  const ask = async (question) => {
    question = question.trim();
    if (!question) return;
    input.value = '';
    history.push({ q: question });
    const slot = { pending: true };
    history.push(slot);
    draw();
    try { Object.assign(slot, { pending: false, res: await api('/api/ask', { method: 'POST', body: { question, course: state.course || undefined } }) }); }
    catch (err) { Object.assign(slot, { pending: false, error: err.message }); toast(err.message, 'err'); }
    draw();
  };

  root.querySelector('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  chat.addEventListener('click', (e) => {
    const s = e.target.closest('[data-s]');
    if (s) ask(s.dataset.s);
    const g = e.target.closest('[data-go]');
    if (g) location.hash = g.dataset.go;
  });
  draw();
  const q = params.get('q');
  if (q && history[history.length - 2]?.q !== q) ask(q);
  else input.focus();
}
