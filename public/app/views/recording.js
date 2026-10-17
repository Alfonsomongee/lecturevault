// Clase: sticky audio player, notes (editable, with history), transcript, alerts, cards, markers, glossary.
import {
  api, html, mount, esc, icon, clock, msClock, fmtDate, duration, KINDS, renderMarkdown, richText,
  toast, isTyping, isoLocal, fold, courseLabel, confirmDialog, copyText,
} from '../util.js';
import { state, refreshMeta, renderRoute, onLeave, go } from '../main.js';
import { alertCard, bindAlertActions } from './alerts-ui.js';

const localDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : isoLocal(d); };

export async function renderRecording(root, id, params) {
  const [detail, segData] = await Promise.all([api(`/api/recordings/${id}`), api(`/api/recordings/${id}/segments`)]);
  const { recording: rec, ai } = detail;
  const hasAudio = detail.has_audio;
  let notes = detail.notes;
  let versions = detail.versions;
  const { alerts, flashcards, markers } = detail;
  const glossary = detail.glossary;
  const segments = segData.segments;
  const totalSec = Math.max(rec.duration_seconds || 0, (segments.at(-1)?.end_ms || 0) / 1000);
  let tab = params.get('tab') || 'notes';
  let follow = true;
  let editing = false;

  const courseNames = [...new Set([...state.catalog.map((c) => c.label), ...state.courses.map((c) => c.course).filter(Boolean)])];

  mount(root, html`
    <div class="crumbs"><a href="#/">Clases</a> / <span>${rec.course ? courseLabel(rec.course) : 'Sin asignatura'}</span></div>
    <label class="sr-only" for="title-input">Título</label>
    <textarea class="title-input" id="title-input" rows="1" maxlength="200">${rec.title}</textarea>
    <dl class="props">
      <dt>Asignatura</dt><dd><input class="input" id="course-input" list="course-dl" value="${rec.course}" placeholder="Sin asignatura" maxlength="120" style="width:100%;max-width:420px">
        <datalist id="course-dl">${courseNames.map((c) => html`<option value="${c}"></option>`)}</datalist></dd>
      <dt>Fecha</dt><dd><input class="input" id="date-input" type="date" value="${localDate(rec.created_at)}" title="Fecha real de la clase: sirve para interpretar fechas como «hasta el día 20»"></dd>
      <dt>Duración</dt><dd><span class="muted">${duration(totalSec)}</span></dd>
      <dt>Audio</dt><dd><span class="muted">${hasAudio ? 'Disponible en este equipo' : 'No disponible'}</span></dd>
    </dl>

    <section class="player" id="player" aria-label="Reproductor">
      ${hasAudio ? html`
        <audio id="audio" preload="metadata" src="/api/recordings/${rec.id}/audio"></audio>
        <div class="player-row">
          <button class="btn icon ghost" id="back10" type="button" title="Retroceder 10 s (J)" aria-label="Retroceder 10 segundos">${icon('back')}</button>
          <button class="play-btn" id="play" type="button" aria-label="Reproducir">${icon('play', 14)}</button>
          <button class="btn icon ghost" id="fwd10" type="button" title="Adelantar 10 s (L)" aria-label="Adelantar 10 segundos">${icon('fwd')}</button>
          <span class="player-time"><span id="cur">00:00</span> / <span id="dur">${clock(totalSec)}</span></span>
          <div class="scrub" id="scrub" role="slider" tabindex="0" aria-label="Posición" aria-valuemin="0" aria-valuemax="${Math.round(totalSec)}" aria-valuenow="0">
            <div class="scrub-track"><div class="scrub-fill" id="fill"></div></div>
            <div class="scrub-thumb" id="thumb" style="left:0"></div>
            <div id="marks"></div>
            <div class="scrub-tip" id="tip" hidden></div>
          </div>
          <select class="speed" id="speed" aria-label="Velocidad">${[0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => html`<option value="${s}" ${s === 1 ? html`selected` : ''}>${s}×</option>`)}</select>
          <button class="btn icon ghost" id="flag" type="button" title="Añadir una marca en este minuto" aria-label="Añadir marca">${icon('flag')}</button>
        </div>`
      : html`<p class="no-audio">Esta clase no tiene audio en este equipo. Los minutos de los apuntes no reproducirán sonido.</p>`}
    </section>

    <div class="tabs" role="tablist" aria-label="Contenido de la clase">
      <button class="tab" role="tab" data-tab="notes">Apuntes</button>
      <button class="tab" role="tab" data-tab="transcript">Transcripción</button>
      <button class="tab" role="tab" data-tab="alerts">Avisos<span class="n" id="n-alerts"></span></button>
      <button class="tab" role="tab" data-tab="cards">Tarjetas<span class="n" id="n-cards"></span></button>
      <button class="tab" role="tab" data-tab="markers">Marcas<span class="n" id="n-markers"></span></button>
      <button class="tab" role="tab" data-tab="gloss">Glosario</button>
    </div>
    <div class="tab-body" id="panel" role="tabpanel"></div>

    <div class="toolbar" style="margin-top:48px;border-top:1px solid var(--border);padding-top:14px">
      <span class="muted small">Borra el audio, la transcripción y todo lo generado de esta clase.</span><span class="spacer"></span>
      <button class="btn sm" id="del-files" type="button" style="color:var(--danger)">Eliminar clase</button>
    </div>
  `);

  const audio = root.querySelector('#audio');
  const panel = root.querySelector('#panel');

  // ── Time sync (transcript + notes follow the audio) ──────
  let stamps = [];
  const findSeg = (ms) => {
    let lo = 0, hi = segments.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segments[mid].start_ms <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  let curSeg = -1, curBlock = null;
  const syncUI = (sec) => {
    const idx = findSeg(sec * 1000 + 250);
    if (idx !== curSeg) {
      panel.querySelector('.seg.is-current')?.classList.remove('is-current');
      curSeg = idx;
      const el = tab === 'transcript' ? panel.querySelector(`[data-seg="${idx}"]`) : null;
      if (el) {
        el.classList.add('is-current');
        if (follow) { const r = el.getBoundingClientRect(); if (r.top < 120 || r.bottom > innerHeight - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      }
    }
    let block = null;
    for (const s of stamps) { if (s.t <= sec + 0.3) block = s.block; else break; }
    if (block !== curBlock) {
      curBlock?.classList.remove('is-current-block');
      if (audio && !audio.paused) block?.classList.add('is-current-block');
      curBlock = block;
    }
  };

  const seekTo = (sec, { play = true } = {}) => {
    sec = Math.max(0, Math.min(sec, totalSec || sec));
    if (audio) {
      audio.currentTime = sec;
      if (play) audio.play().catch(() => {});
      paint();
    } else {
      syncUI(sec);
      const el = panel.querySelector(`[data-seg="${findSeg(sec * 1000)}"]`);
      el?.scrollIntoView({ block: 'center' });
    }
  };

  // ── Player ───────────────────────────────────────────────
  const ui = audio ? {
    fill: root.querySelector('#fill'), thumb: root.querySelector('#thumb'),
    cur: root.querySelector('#cur'), scrub: root.querySelector('#scrub'), play: root.querySelector('#play'), lastSec: -1, lastPct: -1,
  } : null;
  function paint() {
    if (!ui) return;
    const t = audio.currentTime || 0;
    const pct = totalSec ? Math.min(100, (t / totalSec) * 100) : 0;
    if (Math.abs(pct - ui.lastPct) >= 0.05) { ui.fill.style.width = `${pct}%`; ui.thumb.style.left = `${pct}%`; ui.lastPct = pct; }
    const sec = Math.floor(t);
    if (sec !== ui.lastSec) { ui.cur.textContent = clock(t); ui.scrub.setAttribute('aria-valuenow', String(sec)); ui.lastSec = sec; }
    syncUI(t);
  }

  const drawMarks = () => {
    if (!audio || !totalSec) return;
    const items = [
      ...alerts.filter((a) => !a.dismissed).map((a) => ({ key: `a${a.id}`, t: a.t_ms, c: (KINDS[a.kind] || {}).color, label: `${(KINDS[a.kind] || {}).label || a.kind}: ${a.text}` })),
      ...markers.map((m) => ({ key: `m${m.id}`, t: m.t_ms, c: 'var(--text)', label: `Marca: ${m.text}` })),
    ];
    mount(root.querySelector('#marks'), html`${items.map((i) => html`<button class="marker" type="button" data-t="${i.t}" data-label="${i.label}" aria-label="${i.label} (${msClock(i.t)})"
      style="left:${Math.min(100, (i.t / 1000 / totalSec) * 100)}%;--c:${i.c || 'var(--text-3)'}"></button>`)}`);
  };

  let lastSaved = -1;
  const savePosition = () => {
    if (!audio) return;
    const t = Math.floor(audio.currentTime || 0);
    if (t === lastSaved || t < 1) return;
    lastSaved = t;
    api(`/api/recordings/${rec.id}/position`, { method: 'PUT', body: { t } }).catch(() => {});
  };

  function keys(e) {
    if (!audio || isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    const onSlider = document.activeElement?.closest('[role="slider"]');
    if (e.key === ' ' && !document.activeElement?.closest('button')) { e.preventDefault(); audio.paused ? audio.play().catch(() => {}) : audio.pause(); }
    else if (e.key === 'ArrowRight' && !onSlider) seekTo(audio.currentTime + 5, { play: false });
    else if (e.key === 'ArrowLeft' && !onSlider) seekTo(audio.currentTime - 5, { play: false });
    else if (e.key.toLowerCase() === 'j') seekTo(audio.currentTime - 10, { play: false });
    else if (e.key.toLowerCase() === 'l') seekTo(audio.currentTime + 10, { play: false });
  }
  addEventListener('keydown', keys);

  if (audio) {
    let raf = 0;
    const loop = () => { paint(); raf = requestAnimationFrame(loop); };
    audio.addEventListener('play', () => { ui.play.innerHTML = icon('pause', 14).__raw; ui.play.setAttribute('aria-label', 'Pausar'); cancelAnimationFrame(raf); loop(); });
    const stop = () => { ui.play.innerHTML = icon('play', 14).__raw; ui.play.setAttribute('aria-label', 'Reproducir'); cancelAnimationFrame(raf); paint(); savePosition(); curBlock?.classList.remove('is-current-block'); curBlock = null; };
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    audio.addEventListener('seeked', paint);
    audio.addEventListener('loadedmetadata', () => { if (isFinite(audio.duration)) root.querySelector('#dur').textContent = clock(audio.duration); });
    ui.play.onclick = () => (audio.paused ? audio.play().catch(() => toast('El navegador no pudo reproducir este audio', 'err')) : audio.pause());
    root.querySelector('#back10').onclick = () => seekTo(audio.currentTime - 10, { play: false });
    root.querySelector('#fwd10').onclick = () => seekTo(audio.currentTime + 10, { play: false });
    root.querySelector('#speed').onchange = (e) => { audio.playbackRate = Number(e.target.value); };
    root.querySelector('#flag').onclick = () => { tab = 'markers'; drawTab(); panel.querySelector('#marker-text')?.focus(); };

    const scrub = ui.scrub;
    const fromEvent = (e) => { const r = scrub.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * totalSec; };
    let dragging = false;
    scrub.addEventListener('pointerdown', (e) => { if (e.target.closest('.marker')) return; dragging = true; scrub.setPointerCapture(e.pointerId); seekTo(fromEvent(e), { play: false }); });
    scrub.addEventListener('pointermove', (e) => { if (dragging) seekTo(fromEvent(e), { play: false }); });
    scrub.addEventListener('pointerup', () => { dragging = false; });
    scrub.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { seekTo(audio.currentTime + 5, { play: false }); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { seekTo(audio.currentTime - 5, { play: false }); e.preventDefault(); }
    });
    const tip = root.querySelector('#tip');
    const showTip = (b) => { tip.textContent = b.dataset.label; tip.style.left = `${Math.max(14, Math.min(86, parseFloat(b.style.left)))}%`; tip.hidden = false; };
    scrub.addEventListener('pointerover', (e) => { const b = e.target.closest('.marker'); if (b) showTip(b); });
    scrub.addEventListener('pointerout', (e) => { if (e.target.closest('.marker')) tip.hidden = true; });
    scrub.addEventListener('focusin', (e) => { const b = e.target.closest('.marker'); if (b) showTip(b); });
    scrub.addEventListener('focusout', () => { tip.hidden = true; });
    scrub.addEventListener('click', (e) => { const b = e.target.closest('.marker'); if (b) seekTo(Math.max(0, Number(b.dataset.t) / 1000 - 2)); });

    // Resume where the student left off (position is stored in the database)
    const startAt = params.get('t') !== null ? Number(params.get('t')) : detail.position > 5 && detail.position < totalSec - 10 ? detail.position : 0;
    const begin = () => { if (startAt > 0) seekTo(startAt, { play: params.get('t') !== null }); };
    if (audio.readyState >= 1) begin(); else audio.addEventListener('loadedmetadata', begin, { once: true });
    const timer = setInterval(() => { if (!audio.paused) savePosition(); }, 5000);
    onLeave(() => { clearInterval(timer); cancelAnimationFrame(raf); savePosition(); audio.pause(); removeEventListener('keydown', keys); });
    drawMarks();
  } else {
    onLeave(() => removeEventListener('keydown', keys));
    if (params.get('t') !== null) setTimeout(() => seekTo(Number(params.get('t')), { play: false }), 50);
  }

  // ── Tabs ─────────────────────────────────────────────────
  const counts = () => {
    const live = alerts.filter((a) => !a.dismissed).length;
    root.querySelector('#n-alerts').textContent = live ? live : '';
    root.querySelector('#n-cards').textContent = flashcards.length || '';
    root.querySelector('#n-markers').textContent = markers.length || '';
  };
  const folded = segments.map((x) => fold(x.text));

  const saveNotes = async (markdown) => {
    const res = await api(`/api/recordings/${rec.id}/notes`, { method: 'PUT', body: { markdown } });
    notes = { markdown, model: 'manual' };
    versions = res.versions;
    toast('Apuntes guardados');
  };

  const drawNotes = () => {
    stamps = [];
    curBlock = null;
    if (editing) {
      mount(panel, html`
        <div class="notes-bar"><button class="btn primary sm" id="save-notes" type="button">Guardar</button>
          <button class="btn sm" id="cancel-notes" type="button">Cancelar</button>
          <span class="muted small">Markdown. Escribe [14:20] para enlazar un minuto y $…$ para una fórmula. Ctrl+S guarda.</span></div>
        <label class="sr-only" for="editor">Apuntes en Markdown</label>
        <textarea class="input editor" id="editor" spellcheck="true"></textarea>`);
      const ta = panel.querySelector('#editor');
      ta.value = notes?.markdown || '';
      ta.focus();
      const commit = async () => {
        try { await saveNotes(ta.value); editing = false; drawNotes(); }
        catch (err) { toast(err.message, 'err'); }
      };
      panel.querySelector('#save-notes').onclick = commit;
      panel.querySelector('#cancel-notes').onclick = () => { editing = false; drawNotes(); };
      ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); commit(); } });
      return;
    }
    if (!notes) {
      mount(panel, html`<div class="empty"><h3>Esta clase aún no tiene apuntes</h3>
        <p>${ai ? 'Puedes escribirlos tú o generarlos a partir de la transcripción, con marcas de tiempo, avisos y tarjetas.' : 'Puedes escribirlos tú. Para generarlos automáticamente hace falta configurar GEMINI_API_KEY en el archivo .env.'}</p>
        <div class="tags"><button class="btn" id="write" type="button">Escribir apuntes</button>
        ${ai ? html`<button class="btn primary" id="gen" type="button">Generar con IA</button>` : ''}</div></div>`);
      return;
    }
    mount(panel, html`
      <div class="notes-bar">
        <button class="btn sm" id="edit" type="button">${icon('edit', 14)} Editar</button>
        <button class="btn sm" id="copy-md" type="button">${icon('copy', 14)} Copiar</button>
        <button class="btn sm" id="dl-md" type="button">${icon('download', 14)} .md</button>
        <button class="btn sm" id="print" type="button">Imprimir</button>
        <span class="versions"><button class="btn sm" id="ver" type="button" ${versions.length ? '' : html`disabled`}>${icon('history', 14)} Versiones ${versions.length ? `(${versions.length})` : ''}</button>
          <div class="pop" id="ver-pop" hidden>${versions.map((v) => html`<button type="button" data-v="${v.id}"><span>${fmtDate(v.created_at.replace(' ', 'T') + 'Z', true)}</span><span class="muted">${v.model || 'importado'}</span></button>`)}</div></span>
        ${ai ? html`<button class="btn sm ghost" id="regen" type="button">Regenerar con IA</button>` : ''}
        <span class="spacer"></span><span class="muted small">${notes.model === 'manual' ? 'Editado a mano' : notes.model || ''}</span>
      </div>
      <div class="toc" id="toc" hidden></div>
      <div class="prose" id="prose"></div>`);
    const prose = panel.querySelector('#prose');
    prose.replaceChildren(...renderMarkdown(notes.markdown).childNodes);
    const heads = [...prose.querySelectorAll('h2')];
    const toc = panel.querySelector('#toc');
    toc.hidden = heads.length < 3;
    mount(toc, html`${heads.map((h, i) => html`<button type="button" data-h="${i}">${h.textContent.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').replace(/^\s*\d+\.\s*/, '').trim()}</button>`)}`);
    toc.onclick = (e) => { const b = e.target.closest('[data-h]'); if (b) heads[Number(b.dataset.h)]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    stamps = [...prose.querySelectorAll('button.ts')]
      .map((el) => ({ t: Number(el.dataset.t), block: el.closest('li, p, h1, h2, h3, h4, blockquote') || el.parentElement }))
      .sort((a, b) => a.t - b.t);
    prose.addEventListener('click', (e) => { const b = e.target.closest('button.ts'); if (b) seekTo(Number(b.dataset.t)); });
  };

  const drawTab = () => {
    counts();
    root.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'notes') drawNotes();
    else if (tab === 'transcript') {
      mount(panel, html`
        <div class="toolbar" style="margin-top:0">
          <label class="sr-only" for="seg-filter">Buscar en esta clase</label>
          <input class="input" id="seg-filter" type="search" placeholder="Buscar en esta clase" style="width:260px">
          <span class="spacer"></span>
          <label class="follow"><input type="checkbox" id="follow" checked> Seguir el audio</label></div>
        <div id="segs">${segments.length ? segments.map((s, i) => html`
          <button class="seg ${s.doubtful ? 'doubtful' : ''}" type="button" data-seg="${i}" data-t="${s.start_ms}" title="${s.doubtful ? 'Reconocimiento dudoso: escucha el audio' : ''}">
            <span class="t">${msClock(s.start_ms)}</span><span class="x">${s.text}</span></button>`)
          : html`<p class="muted">Sin transcripción.</p>`}</div>`);
      panel.querySelector('#follow').onchange = (e) => { follow = e.target.checked; };
      let filterTimer;
      panel.querySelector('#seg-filter').oninput = (e) => {
        clearTimeout(filterTimer);
        const value = e.target.value;
        filterTimer = setTimeout(() => {
          const q = fold(value.trim());
          panel.querySelectorAll('.seg').forEach((el) => {
            const idx = Number(el.dataset.seg);
            const text = segments[idx].text;
            const match = !q || folded[idx].includes(q);
            el.hidden = !match;
            const x = el.querySelector('.x');
            if (match && q) { const i = folded[idx].indexOf(q); x.innerHTML = `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`; }
            else x.textContent = text;
          });
        }, 120);
      };
      curSeg = -1;
      if (audio) syncUI(audio.currentTime || 0);
    } else if (tab === 'alerts') {
      mount(panel, html`
        <div class="toolbar" style="margin-top:0"><button class="btn sm" id="new-alert" type="button">${icon('plus', 14)} Nuevo aviso</button></div>
        <div id="alert-form"></div>
        ${alerts.length ? alerts.map((a) => alertCard(a, { withSource: false, inline: true }))
          : html`<div class="empty"><p>Sin avisos. ${ai ? 'Procesa la clase con IA para detectar exámenes, entregas y advertencias, o añade uno a mano.' : 'Puedes añadirlos a mano.'}</p></div>`}`);
    } else if (tab === 'cards') {
      mount(panel, html`
        <div class="toolbar" style="margin-top:0">
          <button class="btn sm" id="new-card" type="button">${icon('plus', 14)} Nueva tarjeta</button><span class="spacer"></span>
          <a class="btn sm" href="/api/export/anki?kind=basic&recording=${rec.id}" download>${icon('download', 14)} Anki básicas</a>
          <a class="btn sm" href="/api/export/anki?kind=cloze&recording=${rec.id}" download>${icon('download', 14)} Anki cloze</a>
          <a class="btn sm" href="#/study">Repasar</a></div>
        <div id="card-form"></div>
        ${flashcards.length ? flashcards.map((c) => html`<div class="item" data-cid="${c.id}">
          <div class="body"><div class="txt">${richText(c.front)}</div>
            <div class="muted" style="margin-top:2px">${c.kind === 'cloze' ? richText(c.front, { reveal: true }) : richText(c.back)}</div>
            <div class="meta"><button class="btn sm" data-listen="${c.t_ms}" type="button">${icon('play', 12)} ${msClock(c.t_ms)}</button>
              <span class="tag">${c.kind === 'cloze' ? 'Cloze' : 'Básica'}</span>${c.tag ? html`<span class="tag">${c.tag}</span>` : ''}${c.source === 'manual' ? html`<span class="tag">Manual</span>` : ''}</div></div>
          <div class="acts"><button class="btn sm" data-card="edit" type="button">Editar</button><button class="btn sm ghost" data-card="del" type="button">Eliminar</button></div></div>`)
          : html`<div class="empty"><p>Sin tarjetas todavía.</p></div>`}`);
    } else if (tab === 'markers') {
      mount(panel, html`
        <form class="form-row" id="marker-form">
          <div class="field grow"><label for="marker-text">Nota para el minuto <b id="marker-at">${msClock(Math.round((audio?.currentTime || 0) * 1000))}</b></label>
            <input class="input" id="marker-text" maxlength="500" placeholder="Qué quieres recordar de este momento"></div>
          <button class="btn primary" type="submit">Añadir marca</button></form>
        ${markers.length ? markers.map((m) => html`<div class="item" data-mid="${m.id}">
          <div class="body"><div class="txt">${m.text}</div><div class="meta"><button class="btn sm" data-listen="${m.t_ms}" type="button">${icon('play', 12)} ${msClock(m.t_ms)}</button></div></div>
          <div class="acts"><button class="btn sm ghost icon" data-marker-del type="button" aria-label="Borrar marca">${icon('trash', 14)}</button></div></div>`)
          : html`<div class="empty"><p>Sin marcas. Pulsa la bandera del reproductor para guardar un momento.</p></div>`}`);
    } else {
      mount(panel, glossary.length ? html`${glossary.map((g) => html`<div class="item"><div class="body"><div class="txt">${g.term}</div><div class="muted">${g.definition}</div>
        ${g.t_ms ? html`<div class="meta"><button class="btn sm" data-listen="${g.t_ms}" type="button">${icon('play', 12)} ${msClock(g.t_ms)}</button></div>` : ''}</div></div>`)}`
        : html`<div class="empty"><p>Sin glosario todavía.</p></div>`);
    }
  };

  root.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b && !editing) { tab = b.dataset.tab; drawTab(); }
  });

  // Delegated handlers for every tab
  panel.addEventListener('click', async (e) => {
    const t = e.target;
    const seg = t.closest('.seg');
    if (seg) return seekTo(Number(seg.dataset.t) / 1000);
    const listen = t.closest('[data-listen]');
    if (listen) return seekTo(Number(listen.dataset.listen) / 1000);

    if (t.closest('#edit') || t.closest('#write')) { editing = true; drawNotes(); }
    else if (t.closest('#copy-md')) toast((await copyText(notes.markdown)) ? 'Markdown copiado' : 'No se pudo copiar');
    else if (t.closest('#print')) window.print();
    else if (t.closest('#dl-md')) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([notes.markdown], { type: 'text/markdown' }));
      a.download = `${rec.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'clase'}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (t.closest('#ver')) panel.querySelector('#ver-pop').hidden = !panel.querySelector('#ver-pop').hidden;
    else if (t.closest('[data-v]')) {
      const vid = Number(t.closest('[data-v]').dataset.v);
      if (await confirmDialog('Restaurar esta versión de los apuntes', { confirm: 'Restaurar', detail: 'La versión actual se guarda en el historial.' })) {
        try { const r = await api(`/api/recordings/${rec.id}/notes/restore`, { method: 'POST', body: { version: vid } }); notes = { ...notes, markdown: r.markdown, model: 'manual' }; versions = r.versions; drawNotes(); toast('Versión restaurada'); }
        catch (err) { toast(err.message, 'err'); }
      }
    } else if (t.closest('#gen') || t.closest('#regen')) {
      const btn = t.closest('button');
      if (btn.id === 'regen' && !(await confirmDialog('Regenerar apuntes, avisos y tarjetas', { confirm: 'Regenerar', detail: 'Se vuelve a llamar a Gemini. Tus apuntes actuales se guardan en el historial; tus confirmaciones, avisos y tarjetas manuales y repasos se conservan.' }))) return;
      btn.disabled = true; btn.textContent = 'Procesando, puede tardar un minuto';
      try {
        const { report } = await api(`/api/recordings/${rec.id}/process`, { method: 'POST', body: { force: btn.id === 'regen' } });
        toast(report.errors.length ? report.errors[0] : `Listo: ${report.alerts} avisos, ${report.flashcards} tarjetas`, report.errors.length ? 'err' : 'ok');
        await refreshMeta(); await renderRoute();
      } catch (err) { toast(err.message, 'err', 7000); btn.disabled = false; }
    }

    // alert form
    else if (t.closest('#new-alert')) {
      mount(panel.querySelector('#alert-form'), html`<form class="form-row" id="alert-new">
        <div class="field"><label for="na-kind">Tipo</label><select class="input" id="na-kind">${Object.entries(KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></div>
        <div class="field grow"><label for="na-text">Texto</label><input class="input" id="na-text" maxlength="400" required></div>
        <div class="field"><label for="na-date">Fecha</label><input class="input" id="na-date" type="date"></div>
        <button class="btn primary" type="submit">Añadir</button><button class="btn" type="button" id="na-cancel">Cancelar</button></form>`);
      panel.querySelector('#na-text').focus();
    } else if (t.closest('#na-cancel')) panel.querySelector('#alert-form').innerHTML = '';

    // card form / actions
    else if (t.closest('#new-card')) cardForm();
    else if (t.closest('#cf-cancel')) panel.querySelector('#card-form').innerHTML = '';
    else if (t.closest('[data-card]')) {
      const c = flashcards.find((x) => x.id === Number(t.closest('[data-cid]').dataset.cid));
      if (t.closest('[data-card]').dataset.card === 'edit') cardForm(c);
      else if (await confirmDialog('Eliminar esta tarjeta', { confirm: 'Eliminar', danger: true, detail: c.source === 'ai' ? 'Si la regeneras con IA no volverá a aparecer.' : '' })) {
        try { await api(`/api/flashcards/${c.id}`, { method: 'DELETE' }); flashcards.splice(flashcards.indexOf(c), 1); drawTab(); refreshMeta().catch(() => {}); }
        catch (err) { toast(err.message, 'err'); }
      }
    }
    // markers
    else if (t.closest('[data-marker-del]')) {
      try { const r = await api(`/api/recordings/${rec.id}/markers/${t.closest('[data-mid]').dataset.mid}`, { method: 'DELETE' }); markers.splice(0, markers.length, ...r.markers); drawMarks(); drawTab(); }
      catch (err) { toast(err.message, 'err'); }
    }
  });
  document.addEventListener('click', (e) => { const pop = panel.querySelector('#ver-pop'); if (pop && !pop.hidden && !e.target.closest('.versions')) pop.hidden = true; });

  const cardForm = (c) => {
    mount(panel.querySelector('#card-form'), html`<form class="form-row" id="card-edit" data-id="${c?.id || ''}">
      <div class="field"><label for="cf-kind">Tipo</label><select class="input" id="cf-kind"><option value="basic" ${c?.kind !== 'cloze' ? html`selected` : ''}>Básica</option><option value="cloze" ${c?.kind === 'cloze' ? html`selected` : ''}>Cloze</option></select></div>
      <div class="field grow"><label for="cf-front">Anverso (en cloze: usa {{c1::respuesta}})</label><input class="input" id="cf-front" maxlength="2000" required></div>
      <div class="field grow"><label for="cf-back">Reverso</label><input class="input" id="cf-back" maxlength="2000"></div>
      <div class="field"><label for="cf-tag">Etiqueta</label><input class="input" id="cf-tag" maxlength="40"></div>
      <button class="btn primary" type="submit">${c ? 'Guardar' : 'Añadir'}</button><button class="btn" type="button" id="cf-cancel">Cancelar</button></form>`);
    panel.querySelector('#cf-front').value = c?.front || '';
    panel.querySelector('#cf-back').value = c?.back || '';
    panel.querySelector('#cf-tag').value = c?.tag || '';
    panel.querySelector('#cf-front').focus();
  };

  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (e.target.id === 'alert-new') {
        const { alert } = await api(`/api/recordings/${rec.id}/alerts`, {
          method: 'POST',
          body: { kind: panel.querySelector('#na-kind').value, text: panel.querySelector('#na-text').value, due_date: panel.querySelector('#na-date').value || null, t_ms: Math.round((audio?.currentTime || 0) * 1000) },
        });
        alerts.push(alert); drawTab(); drawMarks(); refreshMeta().catch(() => {});
      } else if (e.target.id === 'card-edit') {
        const body = { kind: panel.querySelector('#cf-kind').value, front: panel.querySelector('#cf-front').value, back: panel.querySelector('#cf-back').value, tag: panel.querySelector('#cf-tag').value };
        const cid = e.target.dataset.id;
        if (cid) {
          const { flashcard } = await api(`/api/flashcards/${cid}`, { method: 'PATCH', body });
          Object.assign(flashcards.find((x) => x.id === Number(cid)), flashcard);
        } else {
          const { flashcard } = await api(`/api/recordings/${rec.id}/flashcards`, { method: 'POST', body: { ...body, t_ms: Math.round((audio?.currentTime || 0) * 1000) } });
          flashcards.push(flashcard);
        }
        drawTab(); refreshMeta().catch(() => {});
      } else if (e.target.id === 'marker-form') {
        const text = panel.querySelector('#marker-text').value;
        const r = await api(`/api/recordings/${rec.id}/markers`, { method: 'POST', body: { t_ms: Math.round((audio?.currentTime || 0) * 1000), text } });
        markers.splice(0, markers.length, ...r.markers); drawMarks(); drawTab();
      }
    } catch (err) { toast(err.message, 'err'); }
  });

  bindAlertActions(panel, alerts, () => { drawTab(); drawMarks(); refreshMeta().catch(() => {}); }, (a) => seekTo(Math.max(0, a.t_ms / 1000 - 3)));
  drawTab();

  // ── Header: everything autosaves ─────────────────────────
  const patch = async (body, msg = 'Guardado') => {
    try { await api(`/api/recordings/${rec.id}`, { method: 'PATCH', body }); toast(msg); await refreshMeta(); }
    catch (err) { toast(err.message, 'err'); }
  };
  const titleEl = root.querySelector('#title-input');
  const fit = () => { titleEl.style.height = 'auto'; titleEl.style.height = `${titleEl.scrollHeight}px`; };
  titleEl.addEventListener('input', fit);
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });
  requestAnimationFrame(fit);
  root.querySelector('#title-input').addEventListener('change', (e) => { if (e.target.value.trim()) patch({ title: e.target.value }); });
  root.querySelector('#course-input').addEventListener('change', (e) => patch({ course: e.target.value }));
  root.querySelector('#date-input').addEventListener('change', (e) => { if (e.target.value) patch({ date: e.target.value }); });

  root.querySelector('#del-files').onclick = async () => {
    const collab = !rec.collab_id.startsWith('local:');
    const ok = await confirmDialog('Eliminar esta clase', {
      confirm: 'Eliminar', danger: true,
      detail: `Se borran el audio y la transcripción de la carpeta data, además de apuntes, avisos, tarjetas y marcas. ${collab ? 'La grabación seguirá apareciendo como pendiente de capturar.' : 'No se puede deshacer.'}`,
    });
    if (!ok) return;
    try { await api(`/api/recordings/${rec.id}?files=1`, { method: 'DELETE' }); await refreshMeta(); go('#/'); }
    catch (err) { toast(err.message, 'err'); }
  };
}
