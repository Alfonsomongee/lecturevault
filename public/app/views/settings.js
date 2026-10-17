// Ajustes: IA, tema, asignaturas (catálogo editable), copia de seguridad y rutas de datos.
import { api, html, mount, icon, toast, copyText } from '../util.js';
import { state, setTheme, refreshMeta } from '../main.js';

export async function renderSettings(root) {
  const [sys, cat] = await Promise.all([api('/api/system'), api('/api/catalog')]);
  let courses = cat.courses.map((c) => ({ ...c }));
  const mb = (n) => (n / 1024 / 1024).toFixed(1);

  const draw = () => {
    mount(root, html`
      <h1 class="page-title">Ajustes</h1>
      <p class="page-sub">Todo lo que configuras aquí se guarda en tu base de datos local, no en el navegador.</p>

      <div class="setting"><div><h3>Apariencia</h3></div><div>
        <div class="seg-ctl" role="group" aria-label="Tema">${[['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, l]) => html`<button type="button" data-theme="${k}" aria-pressed="${state.theme === k}">${l}</button>`)}</div></div></div>

      <div class="setting"><div><h3>Inteligencia artificial</h3><p>Apuntes, avisos, tarjetas y respuestas.</p></div><div>
        <p>${sys.ai ? html`<span class="tag tag-green">Activa</span> Modelo ${sys.model}.` : html`<span class="tag">Desactivada</span>`}</p>
        ${sys.ai ? '' : html`<p style="margin-top:6px">Añade tu clave en el archivo <code>.env</code> del proyecto y reinicia el servidor:</p>
          <div class="cmd" style="margin-top:6px"><code>GEMINI_API_KEY=tu_clave</code></div>`}
        <p style="margin-top:6px">Al usarla se envía texto (transcripciones y preguntas) a Google. El audio no sale de este equipo.</p></div></div>

      <div class="setting"><div><h3>Asignaturas</h3><p>Se usan para ordenar las clases y reconocer el código en los títulos. Se guardan en data/courses.json.</p></div><div>
        <table class="db catalog"><thead><tr><th>Código</th><th>Nombre</th><th class="hide-sm">Profesor</th><th class="hide-sm">Id Blackboard</th><th></th></tr></thead><tbody>
          ${courses.map((c, i) => html`<tr data-i="${i}">
            <td><input class="input" data-f="code" value="${c.code}" aria-label="Código"></td>
            <td><input class="input" data-f="name" value="${c.name}" aria-label="Nombre"></td>
            <td class="hide-sm"><input class="input" data-f="teacher" value="${c.teacher || ''}" aria-label="Profesor"></td>
            <td class="hide-sm"><input class="input" data-f="lmsId" value="${c.lmsId || ''}" aria-label="Id Blackboard"></td>
            <td class="acts"><button class="btn sm ghost icon" data-rm type="button" aria-label="Quitar asignatura">${icon('trash', 14)}</button></td></tr>`)}</tbody></table>
        <div class="toolbar"><button class="btn sm" id="add-course" type="button">${icon('plus', 14)} Añadir asignatura</button><span class="spacer"></span>
          <button class="btn primary sm" id="save-courses" type="button">Guardar asignaturas</button></div></div></div>

      <div class="setting"><div><h3>Copia de seguridad</h3><p>Copia consistente de la base de datos (apuntes editados, confirmaciones, repasos). Se guardan las 10 últimas.</p></div><div>
        <button class="btn" id="backup" type="button">Crear copia ahora</button>
        ${sys.backups.length ? html`<ul style="margin:10px 0 0 1.2em" class="muted small">${sys.backups.map((b) => html`<li>${b}</li>`)}</ul>` : html`<p class="muted small" style="margin-top:8px">Aún no hay copias.</p>`}
        <p class="muted small" style="margin-top:8px">El audio y las transcripciones están en la carpeta data; cópiala entera para una copia completa.</p></div></div>

      <div class="setting"><div><h3>Datos</h3></div><dl class="kv">
        <dt>Carpeta de datos</dt><dd>${sys.dataDir}</dd><dt>Base de datos</dt><dd>${sys.dbPath} (${mb(sys.dbBytes)} MB)</dd>
        <dt>Clases</dt><dd>${sys.stats.total} registradas, ${sys.stats.transcribed} transcritas, ${sys.stats.withNotes} con apuntes</dd>
        <dt>Importar</dt><dd><div class="cmd"><code>npm run ingest</code><button class="btn sm" data-copy="npm run ingest" type="button">${icon('copy', 14)}</button></div></dd></dl></div>
    `);

    root.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', async () => { await setTheme(b.dataset.theme); draw(); }));
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => toast((await copyText(b.dataset.copy)) ? 'Copiado' : 'No se pudo copiar')));
    const sync = () => root.querySelectorAll('tr[data-i]').forEach((tr) => tr.querySelectorAll('[data-f]').forEach((inp) => { courses[Number(tr.dataset.i)][inp.dataset.f] = inp.value; }));
    root.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { sync(); courses.splice(Number(b.closest('tr').dataset.i), 1); draw(); }));
    root.querySelector('#add-course').addEventListener('click', () => { sync(); courses.push({ code: '', name: '' }); draw(); root.querySelector('tr:last-child input')?.focus(); });
    root.querySelector('#save-courses').addEventListener('click', async () => {
      sync();
      try {
        const res = await api('/api/catalog', { method: 'PUT', body: { courses: courses.map((c) => ({ code: c.code, name: c.name, teacher: c.teacher || undefined, lmsId: c.lmsId || undefined })) } });
        courses = res.courses.map((c) => ({ ...c }));
        toast('Asignaturas guardadas');
        await refreshMeta(); draw();
      } catch (err) { toast(err.message, 'err'); }
    });
    root.querySelector('#backup').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api('/api/backup', { method: 'POST', body: {} }); toast(`Copia creada (${mb(r.bytes)} MB)`); renderSettings(root); }
      catch (err) { toast(err.message, 'err'); e.currentTarget.disabled = false; }
    });
  };
  draw();
}
