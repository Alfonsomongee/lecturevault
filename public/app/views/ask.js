// Ask your classes: RAG answers with verified, clickable citations.
import { api, html, raw, mount, esc, renderMarkdown, msClock, toast, store, courseLabel } from '../util.js';
import { state } from '../main.js';

const history = [];
const SUGGESTIONS = [
  '¿Qué entra en el examen?',
  '¿Qué peso tiene cada práctica y cuándo se entrega?',
  '¿Cómo se definen las restricciones en Ansys?',
  '¿Qué fórmulas marcó el profesor como importantes?',
];

export async function renderAsk(root, params) {
  mount(root, html`
    <div class="page-head"><div><div class="eyebrow">Tus clases, con fuentes</div><h1>Pregunta a tus clases</h1>
      <p>Respondo solo con lo que se dijo en tus clases y te enseño la cita literal con su minuto. Si no consta, te lo digo.</p></div>
      <span class="badge ${state.ai ? 'ok' : ''}">${state.ai ? '✨ Respuestas redactadas con Gemini' : '🔎 Sin IA: se muestran los fragmentos relevantes'}</span></div>
    <div class="chat" id="chat" aria-live="polite"></div>
    <div class="ask-bar"><form id="ask-form" autocomplete="off">
      <label class="sr-only" for="ask-input">Pregunta</label>
      <input id="ask-input" placeholder="${state.course ? `Pregunta sobre ${courseLabel(state.course)}…` : 'Pregunta sobre cualquiera de tus clases…'}" maxlength="500">
      <button class="btn primary" type="submit">Preguntar</button></form></div>`);

  const chat = root.querySelector('#chat');
  const input = root.querySelector('#ask-input');

  const draw = () => {
    if (history.length === 0) {
      mount(chat, html`<div class="card card-pad"><div class="eyebrow" style="margin-bottom:8px">Ideas para empezar</div>
        <div class="suggest">${SUGGESTIONS.map((s) => html`<button type="button" data-s="${s}">${s}</button>`)}</div></div>`);
      return;
    }
    mount(chat, html`${history.map((m) => m.q !== undefined ? html`<div class="msg-q">${m.q}</div>` : m.pending ? html`
      <div class="card msg-a"><span class="typing"><i></i><i></i><i></i></span> <span class="sub">Buscando en tus clases…</span></div>`
      : html`<div class="card msg-a" data-i="${history.indexOf(m)}">${m.error ? html`<p>⚠️ ${m.error}</p>` : html`<div class="prose answer"></div>
        ${m.res.citations.map((c) => html`<button class="cite" type="button" data-go="#/r/${c.recordingId}?t=${Math.max(0, Math.floor(c.startMs / 1000) - 2)}">
          <span class="cite-id">${c.fragment}</span><span><b>${c.recordingTitle}</b> · ${msClock(c.startMs)}<q>${c.quote}</q></span></button>`)}
        ${m.res.answer === null || !m.res.found ? html`<div style="margin-top:12px"><div class="eyebrow" style="margin-bottom:6px">Fragmentos relevantes</div>
          ${m.res.sources.slice(0, 4).map((s) => html`<button class="cite" type="button" data-go="#/r/${s.recordingId}?t=${Math.max(0, Math.floor(s.startMs / 1000) - 2)}">
            <span class="cite-id">${msClock(s.startMs)}</span><span><b>${s.recordingTitle}</b><q>${s.text.slice(0, 240)}${s.text.length > 240 ? '…' : ''}</q></span></button>`)}</div>` : ''}
        <p class="sub" style="margin-top:10px">${m.res.mode === 'hybrid' ? 'Búsqueda híbrida: palabras clave + significado' : 'Búsqueda por palabras clave'} · ${m.res.sources.length} fragmentos consultados</p>`}</div>`)}`);
    // Fill answer bodies with sanitised markdown, turning [F1] into clickable chips
    chat.querySelectorAll('.msg-a[data-i]').forEach((el) => {
      const m = history[Number(el.dataset.i)];
      const body = el.querySelector('.answer');
      if (!body || !m.res.answer) { body?.remove(); return; }
      const rendered = renderMarkdown(m.res.answer, { timestamps: false });
      rendered.innerHTML = rendered.innerHTML.replace(/\[F(\d+)\]/g, (_, n) => `<button type="button" class="ts" data-f="${Number(n)}">F${Number(n)}</button>`);
      body.replaceChildren(...rendered.childNodes);
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-f]');
        const c = b && m.res.citations.find((x) => x.fragment === `F${b.dataset.f}`);
        if (c) location.hash = `#/r/${c.recordingId}?t=${Math.max(0, Math.floor(c.startMs / 1000) - 2)}`;
      });
    });
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  const ask = async (question) => {
    question = question.trim();
    if (!question) return;
    input.value = '';
    history.push({ q: question });
    const slot = { pending: true };
    history.push(slot);
    draw();
    try {
      const res = await api('/api/ask', { method: 'POST', body: { question, course: state.course || undefined } });
      Object.assign(slot, { pending: false, res });
    } catch (err) {
      Object.assign(slot, { pending: false, error: err.message });
      toast(err.message, 'err');
    }
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
  void raw; void esc; void store;
}
