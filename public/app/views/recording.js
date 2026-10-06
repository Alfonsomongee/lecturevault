// Recording: custom audio player with alert markers, synced transcript, interactive notes.
import {
  api, html, raw, mount, esc, clock, msClock, fmtDate, duration, KINDS, renderMarkdown, richText,
  store, toast, isTyping, isoLocal, fold,
} from '../util.js';
import { state, refreshMeta, renderRoute, onLeave } from '../main.js';
import { alertCard, bindAlertActions } from './alerts-ui.js';

const localDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : isoLocal(d); };

export async function renderRecording(root, id, params) {
  const [detail, segData] = await Promise.all([api(`/api/recordings/${id}`), api(`/api/recordings/${id}/segments`)]);
  const { recording: rec, notes, has_audio: hasAudio, ai } = detail;
  const { alerts, flashcards } = detail;
  const glossary = detail.glossary;
  const segments = segData.segments;
  const totalSec = Math.max(rec.duration_seconds || 0, (segments.at(-1)?.end_ms || 0) / 1000);
  let tab = 'transcript';
  let follow = true;

  const courseNames = [...new Set([...state.catalog.map((c) => c.label), ...state.courses.map((c) => c.course).filter(Boolean)])];
  const courseOptions = courseNames.map((c) => html`<option value="${c}"></option>`);

  mount(root, html`
    <div class="rec-head">
      <div class="crumbs"><a href="#/">Biblioteca</a> › <span>${rec.course || 'Sin asignatura'}</span></div>
      <h1>${rec.title}</h1>
      <div class="rec-meta">
        <span>📅 ${fmtDate(rec.created_at)}</span><span>⏱ ${duration(totalSec)}</span>
        <span class="badge ${hasAudio ? 'ok' : 'off'}">🎧 ${hasAudio ? 'Audio local' : 'Sin audio'}</span>
        <form id="course-form" class="chip-row" style="gap:6px">
          <label class="sr-only" for="course-input">Asignatura</label>
          <input class="input" id="course-input" list="course-dl" value="${rec.course}" placeholder="Asignar asignatura…" maxlength="80" style="width:210px;padding:5px 10px">
          <label class="sr-only" for="date-input">Fecha de la clase</label>
          <input class="input" id="date-input" type="date" value="${localDate(rec.created_at)}" title="Fecha real de la clase: ancla las fechas relativas («hasta el día 20»)" style="padding:5px 10px">
          <datalist id="course-dl">${courseOptions}</datalist>
          <button class="btn sm" type="submit">Guardar</button>
        </form>
      </div>
    </div>

    <div class="rec-grid">
      <aside class="rec-side" aria-label="Reproductor y material">
        <section class="card player" id="player">
          ${hasAudio ? html`
            <audio id="audio" preload="metadata" src="/api/recordings/${rec.id}/audio"></audio>
            <div class="player-row">
              <button class="btn sm ghost" id="back10" type="button" title="Retroceder 10 s (J)" aria-label="Retroceder 10 segundos">⟲ 10</button>
              <button class="play-btn" id="play" type="button" aria-label="Reproducir">▶</button>
              <button class="btn sm ghost" id="fwd10" type="button" title="Adelantar 10 s (L)" aria-label="Adelantar 10 segundos">10 ⟳</button>
              <span class="player-time"><span id="cur">00:00</span> / <span id="dur">${clock(totalSec)}</span></span>
            </div>
            <div class="scrub" id="scrub" role="slider" tabindex="0" aria-label="Posición" aria-valuemin="0" aria-valuemax="${Math.round(totalSec)}" aria-valuenow="0">
              <div class="scrub-track"><div class="scrub-fill" id="fill"></div></div>
              <div class="scrub-thumb" id="thumb" style="left:0"></div>
              ${totalSec ? alerts.filter((a) => !a.dismissed).map((a) => {
                const k = KINDS[a.kind] || { icon: '•', color: 'var(--muted)', label: a.kind };
                return html`<button class="marker" type="button" data-alert="${a.id}" style="left:${Math.min(100, (a.t_ms / 1000 / totalSec) * 100)}%;--c:${k.color}"
                  aria-label="${k.label} en ${msClock(a.t_ms)}: ${a.text}"></button>`;
              }) : ''}
              <div class="scrub-tip" id="tip" hidden></div>
            </div>
            <div class="player-tools">
              <label class="sub" for="speed">Velocidad</label>
              <select class="speed" id="speed">${[0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => html`<option value="${s}" ${s === 1 ? raw('selected') : ''}>${s}×</option>`)}</select>
              <span class="sub" style="margin-left:auto">Espacio ⏯ · ←/→ ±5 s</span>
            </div>`
          : html`<div class="no-audio">🎧 Esta clase no tiene audio local. Puedes leer los apuntes y la transcripción; los minutos no reproducirán sonido.</div>`}
        </section>

        <section class="card" style="display:flex;flex-direction:column;min-height:0;flex:1;overflow:hidden">
          <div class="tabs" role="tablist" aria-label="Material de la clase">
            <button class="tab" role="tab" data-tab="transcript" aria-selected="true">Transcripción</button>
            <button class="tab" role="tab" data-tab="alerts" aria-selected="false">Avisos<span class="n" id="n-alerts"></span></button>
            <button class="tab" role="tab" data-tab="cards" aria-selected="false">Tarjetas<span class="n" id="n-cards"></span></button>
            <button class="tab" role="tab" data-tab="gloss" aria-selected="false">Glosario</button>
          </div>
          <div class="panel" id="panel" role="tabpanel"></div>
        </section>
      </aside>

      <article class="card notes" aria-label="Apuntes">
        <div class="notes-bar" id="notes-bar"></div>
        <div id="toc" class="toc" hidden></div>
        <div class="prose" id="prose"></div>
      </article>
    </div>
  `);

  const audio = root.querySelector('#audio');
  const panel = root.querySelector('#panel');
  const prose = root.querySelector('#prose');

  // ── Notes ────────────────────────────────────────────────
  let stamps = [];
  const drawNotes = () => {
    const bar = root.querySelector('#notes-bar');
    if (!notes) {
      mount(bar, html``);
      mount(prose, html`<div class="empty-state"><div class="icon">📝</div><h2>Aún no hay apuntes</h2>
        <p>${ai ? 'Genera apuntes limpios con marcas de tiempo, avisos críticos y tarjetas de estudio a partir de la transcripción.'
                 : 'Configura GEMINI_API_KEY en .env para generar apuntes con IA. Mientras tanto puedes buscar y leer la transcripción.'}</p>
        ${ai ? html`<button class="btn primary" id="gen" type="button">✨ Generar apuntes con IA</button>` : ''}</div>`);
      root.querySelector('#toc').hidden = true;
      return;
    }
    mount(bar, html`
      <span class="eyebrow">Apuntes · ${notes.model || 'importados'}</span><span style="flex:1"></span>
      <button class="btn sm" id="copy-md" type="button">📋 Copiar</button>
      <button class="btn sm" id="dl-md" type="button">⬇ .md</button>
      <button class="btn sm" id="print" type="button">🖨 Imprimir</button>
      ${ai ? html`<button class="btn sm ghost" id="regen" type="button" title="Vuelve a llamar a Gemini">↻ Regenerar</button>` : ''}`);
    prose.replaceChildren(...renderMarkdown(notes.markdown).childNodes);
    const heads = [...prose.querySelectorAll('h2, h3')];
    const toc = root.querySelector('#toc');
    toc.hidden = heads.length < 3;
    mount(toc, html`${heads.filter((h) => h.tagName === 'H2').map((h, i) => html`<button type="button" data-h="${i}">${h.textContent.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').replace(/^\s*\d+\.\s*/, '').trim()}</button>`)}`);
    toc.onclick = (e) => {
      const b = e.target.closest('[data-h]');
      if (b) prose.querySelectorAll('h2')[Number(b.dataset.h)]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    stamps = [...prose.querySelectorAll('button.ts')]
      .map((el) => ({ t: Number(el.dataset.t), block: el.closest('li, p, h1, h2, h3, h4, blockquote') || el.parentElement }))
      .sort((a, b) => a.t - b.t);
  };
  drawNotes();

  // ── Seeking / time sync ──────────────────────────────────
  const findSeg = (ms) => {
    let lo = 0, hi = segments.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segments[mid].start_ms <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  // Scroll inside the transcript panel only: scrollIntoView would also move the whole page.
  const reveal = (el, center = false) => {
    const r = el.getBoundingClientRect(), p = panel.getBoundingClientRect();
    if (center || r.top < p.top || r.bottom > p.bottom) {
      panel.scrollTo({ top: panel.scrollTop + (r.top - p.top) - (p.height / 2 - r.height / 2), behavior: 'smooth' });
    }
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
        if (follow) reveal(el);
      }
    }
    let block = null;
    for (const s of stamps) { if (s.t <= sec + 0.3) block = s.block; else break; }
    if (block !== curBlock) {
      curBlock?.classList.remove('is-current-block');
      block?.classList.add('is-current-block');
      curBlock = block;
    }
  };

  const seekTo = (sec, { play = true } = {}) => {
    sec = Math.max(0, Math.min(sec, totalSec || sec));
    if (audio) {
      audio.currentTime = sec;
      if (play) audio.play().catch(() => {});
      paint(); // also syncs transcript + notes
    } else {
      syncUI(sec);
    }
    if (!audio) { const el = panel.querySelector(`[data-seg="${findSeg(sec * 1000)}"]`); if (el) reveal(el, true); }
  };

  // ── Player ───────────────────────────────────────────────
  let raf = 0;
  const ui = audio ? {
    fill: root.querySelector('#fill'), thumb: root.querySelector('#thumb'),
    cur: root.querySelector('#cur'), scrub: root.querySelector('#scrub'), lastSec: -1, lastPct: -1,
  } : null;
  function paint() {
    if (!ui) return;
    const t = audio.currentTime || 0;
    const pct = totalSec ? Math.min(100, (t / totalSec) * 100) : 0;
    if (Math.abs(pct - ui.lastPct) >= 0.05) {
      ui.fill.style.width = `${pct}%`;
      ui.thumb.style.left = `${pct}%`;
      ui.lastPct = pct;
    }
    const sec = Math.floor(t);
    if (sec !== ui.lastSec) {
      ui.cur.textContent = clock(t);
      ui.scrub.setAttribute('aria-valuenow', String(sec));
      ui.lastSec = sec;
    }
    syncUI(t);
  }
  if (audio) {
    const playBtn = root.querySelector('#play');
    const loop = () => { paint(); raf = requestAnimationFrame(loop); };
    audio.addEventListener('play', () => { playBtn.textContent = '❚❚'; playBtn.setAttribute('aria-label', 'Pausar'); cancelAnimationFrame(raf); loop(); });
    const stop = () => { playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Reproducir'); cancelAnimationFrame(raf); paint(); };
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    audio.addEventListener('seeked', paint);
    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration)) root.querySelector('#dur').textContent = clock(audio.duration);
    });
    playBtn.onclick = () => (audio.paused ? audio.play().catch(() => toast('El navegador no pudo reproducir este audio', 'err')) : audio.pause());
    root.querySelector('#back10').onclick = () => seekTo(audio.currentTime - 10, { play: false });
    root.querySelector('#fwd10').onclick = () => seekTo(audio.currentTime + 10, { play: false });
    root.querySelector('#speed').onchange = (e) => { audio.playbackRate = Number(e.target.value); };

    const scrub = root.querySelector('#scrub');
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
    const showTip = (btn) => {
      const a = alerts.find((x) => x.id === Number(btn.dataset.alert));
      if (!a) return;
      const k = KINDS[a.kind];
      tip.textContent = `${k ? k.icon + ' ' + k.label : a.kind} · ${msClock(a.t_ms)} — ${a.text}`;
      tip.style.left = `${Math.max(18, Math.min(82, parseFloat(btn.style.left)))}%`;
      tip.hidden = false;
    };
    scrub.addEventListener('pointerover', (e) => { const b = e.target.closest('.marker'); if (b) showTip(b); });
    scrub.addEventListener('pointerout', (e) => { if (e.target.closest('.marker')) tip.hidden = true; });
    scrub.addEventListener('focusin', (e) => { const b = e.target.closest('.marker'); if (b) showTip(b); });
    scrub.addEventListener('focusout', () => { tip.hidden = true; });
    scrub.addEventListener('click', (e) => {
      const b = e.target.closest('.marker');
      if (!b) return;
      const a = alerts.find((x) => x.id === Number(b.dataset.alert));
      if (a) seekTo(Math.max(0, a.t_ms / 1000 - 3));
    });

    // Resume where the student left off
    const saved = Number(store.get(`lv-pos-${rec.id}`) || 0);
    const startAt = params.get('t') !== null ? Number(params.get('t')) : saved > 5 && saved < totalSec - 10 ? saved : 0;
    const begin = () => { if (startAt > 0) seekTo(startAt, { play: params.get('t') !== null }); };
    if (audio.readyState >= 1) begin(); else audio.addEventListener('loadedmetadata', begin, { once: true });
    const savePos = setInterval(() => { if (!audio.paused) store.set(`lv-pos-${rec.id}`, String(Math.floor(audio.currentTime))); }, 4000);
    onLeave(() => { clearInterval(savePos); cancelAnimationFrame(raf); audio.pause(); removeEventListener('keydown', keys); });
  } else {
    onLeave(() => removeEventListener('keydown', keys));
  }

  function keys(e) {
    if (isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!audio) return;
    if (e.key === ' ' && !document.activeElement?.closest('button, [role="slider"]')) { e.preventDefault(); audio.paused ? audio.play().catch(() => {}) : audio.pause(); }
    else if (e.key === 'ArrowRight' && !document.activeElement?.closest('[role="slider"]')) seekTo(audio.currentTime + 5, { play: false });
    else if (e.key === 'ArrowLeft' && !document.activeElement?.closest('[role="slider"]')) seekTo(audio.currentTime - 5, { play: false });
    else if (e.key.toLowerCase() === 'j') seekTo(audio.currentTime - 10, { play: false });
    else if (e.key.toLowerCase() === 'l') seekTo(audio.currentTime + 10, { play: false });
  }
  addEventListener('keydown', keys);

  // Click any timestamp in the notes
  prose.addEventListener('click', (e) => {
    const b = e.target.closest('button.ts');
    if (b) seekTo(Number(b.dataset.t));
  });
  // Initial jump when there is no audio (or no autoplay): position transcript
  if (!audio && params.get('t') !== null) setTimeout(() => seekTo(Number(params.get('t')), { play: false }), 50);

  // ── Tabs ─────────────────────────────────────────────────
  const counts = () => {
    const live = alerts.filter((a) => !a.dismissed).length;
    root.querySelector('#n-alerts').textContent = live ? ` ${live}` : '';
    root.querySelector('#n-cards').textContent = flashcards.length ? ` ${flashcards.length}` : '';
  };

  const folded = segments.map((x) => fold(x.text)); // computed once, reused by every filter keystroke

  const drawTab = () => {
    counts();
    root.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'transcript') {
      mount(panel, html`
        <div style="padding:4px 6px 8px;display:flex;gap:8px;align-items:center">
          <label class="sr-only" for="seg-filter">Buscar en esta clase</label>
          <input class="input" id="seg-filter" type="search" placeholder="Buscar en esta clase…" style="flex:1;padding:6px 10px">
          <label class="follow"><input type="checkbox" id="follow" checked> Seguir</label>
        </div>
        <div id="segs">${segments.length ? segments.map((s, i) => html`
          <button class="seg ${s.doubtful ? 'doubtful' : ''}" type="button" data-seg="${i}" data-t="${s.start_ms}" title="${s.doubtful ? 'Reconocimiento dudoso: escucha el audio' : ''}">
            <span class="t">${msClock(s.start_ms)}</span><span class="x">${s.text}</span></button>`)
          : html`<p class="sub" style="padding:12px">Sin transcripción.</p>`}</div>`);
      panel.querySelector('#follow').onchange = (e) => { follow = e.target.checked; };
      let filterTimer;
      panel.querySelector('#seg-filter').oninput = (e) => {
        clearTimeout(filterTimer);
        const value = e.target.value;
        filterTimer = setTimeout(() => applyFilter(value), 120);
      };
      const applyFilter = (value) => {
        const q = fold(value.trim());
        panel.querySelectorAll('.seg').forEach((el) => {
          const idx = Number(el.dataset.seg);
          const text = segments[idx].text;
          const match = !q || folded[idx].includes(q);
          el.hidden = !match;
          const x = el.querySelector('.x');
          if (match && q) {
            const i = folded[idx].indexOf(q);
            x.innerHTML = `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
          } else x.textContent = text;
        });
      };
      curSeg = -1;
      if (audio) syncUI(audio.currentTime || 0);
    } else if (tab === 'alerts') {
      mount(panel, alerts.length ? html`${alerts.map((a) => alertCard(a, { withSource: false, inline: true }))}`
        : html`<p class="sub" style="padding:14px">Sin avisos. ${ai ? 'Procesa la clase con IA para detectar exámenes, entregas y advertencias.' : ''}</p>`);
    } else if (tab === 'cards') {
      mount(panel, flashcards.length ? html`
        <div class="chip-row" style="padding:6px">
          <a class="btn sm" href="/api/export/anki?kind=basic&recording=${rec.id}" download>⬇ Anki (básicas)</a>
          <a class="btn sm" href="/api/export/anki?kind=cloze&recording=${rec.id}" download>⬇ Anki (cloze)</a>
          <a class="btn sm primary" href="#/study">Repasar</a></div>
        ${flashcards.map((c) => html`<div class="mini-card">
          <div class="q">${richText(c.front, { reveal: false })}</div>
          <div class="a">${c.kind === 'cloze' ? richText(c.front, { reveal: true }) : richText(c.back)}</div>
          <div class="sub" style="margin-top:6px"><button class="btn sm ghost" data-listen="${c.t_ms}" type="button">▶ ${msClock(c.t_ms)}</button> ${c.tag ? `#${c.tag}` : ''}</div></div>`)}`
        : html`<p class="sub" style="padding:14px">Sin tarjetas todavía.</p>`);
    } else {
      mount(panel, glossary.length ? html`${glossary.map((g) => html`<div class="gloss"><b>${g.term}</b><span>${g.definition}</span>
        ${g.t_ms ? html`<div><button class="btn sm ghost" data-listen="${g.t_ms}" type="button">▶ ${msClock(g.t_ms)}</button></div>` : ''}</div>`)}`
        : html`<p class="sub" style="padding:14px">Sin glosario todavía.</p>`);
    }
  };

  root.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) { tab = b.dataset.tab; drawTab(); }
  });
  panel.addEventListener('click', (e) => {
    const segBtn = e.target.closest('.seg');
    if (segBtn) return seekTo(Number(segBtn.dataset.t) / 1000);
    const listen = e.target.closest('[data-listen]');
    if (listen) return seekTo(Number(listen.dataset.listen) / 1000);
  });
  bindAlertActions(panel, alerts, () => { drawTab(); refreshMeta().catch(() => {}); }, (a) => seekTo(Math.max(0, a.t_ms / 1000 - 3)));
  drawTab();

  // ── Header actions ───────────────────────────────────────
  root.querySelector('#course-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const date = root.querySelector('#date-input').value;
      await api(`/api/recordings/${rec.id}`, {
        method: 'PATCH',
        body: { course: root.querySelector('#course-input').value, ...(date && date !== localDate(rec.created_at) ? { date } : {}) },
      });
      toast('Guardado');
      await refreshMeta();
    } catch (err) { toast(err.message, 'err'); }
  });

  const processNow = async (btn, force) => {
    btn.disabled = true; const label = btn.textContent; btn.textContent = '⏳ Procesando con Gemini… (puede tardar ~1 min)';
    try {
      const { report } = await api(`/api/recordings/${rec.id}/process`, { method: 'POST', body: { force } });
      toast(report.errors.length ? report.errors[0] : `Listo: ${report.alerts} avisos · ${report.flashcards} tarjetas`, report.errors.length ? 'err' : 'ok');
      await refreshMeta(); await renderRoute();
    } catch (err) { toast(err.message, 'err', 7000); btn.disabled = false; btn.textContent = label; }
  };
  root.addEventListener('click', (e) => {
    if (e.target.id === 'gen') processNow(e.target, false);
    if (e.target.id === 'regen' && confirm('¿Regenerar apuntes, avisos y tarjetas con Gemini? Tus confirmaciones y repasos se conservan.')) processNow(e.target, true);
    if (e.target.id === 'copy-md') navigator.clipboard?.writeText(notes.markdown).then(() => toast('Markdown copiado'));
    if (e.target.id === 'print') window.print();
    if (e.target.id === 'dl-md') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([notes.markdown], { type: 'text/markdown' }));
      a.download = `${rec.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'clase'}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  });
}
