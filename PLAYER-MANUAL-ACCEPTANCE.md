# Inspección de Capacidades del Reproductor — Hito 2 (Guía de Aceptación Manual)

Esta guía describe el procedimiento exacto paso a paso para ejecutar la **inspección de capacidades del reproductor en modo de solo lectura** para Collab2 / Blackboard Collaborate en **Windows (PowerShell)**.

> **Restricciones Estrictas de Seguridad:**
> 1. **Modo 100% solo lectura:** La herramienta **NUNCA** hace clic automático en reproducir, descargar, subtítulos ni opciones de menú.
> 2. **Sin extracción ni inspección de medios:** No busca URLs de HLS (`.m3u8`), DASH (`.mpd`), fragmentos (`.ts`/`.m4s`), ni intercepta ni descarga vídeo ni audio.
> 3. **Sin elusión de permisos:** No manipula tokens, cookies ni elude restricciones del campus.
> 4. **Privacidad de datos:** No registra tokens de sesión ni contenido de chats privados ni participantes.

---

## 1. Comando de Inspección Guiada

En tu terminal de PowerShell en el directorio raíz del proyecto:

```powershell
npm run inspect:player
```

---

## 2. Flujo del Operador Paso a Paso

1. **Apertura de Chromium:**
   - Se abrirá una ventana visible de Chromium reutilizando tu sesión persistente.
2. **Navegación al curso:**
   - Accede a tu curso y abre la tabla de grabaciones de Collab2.
3. **Apertura manual de una grabación:**
   - Haz clic manualmente en el botón de reproducir de **una** de las grabaciones de prueba.
   - Observa si el reproductor se abre:
     - En la **misma pestaña**,
     - En una **pestaña nueva**, o
     - En una **ventana emergente (popup)**.
4. **Espera de carga:**
   - Espera a que el reproductor de Collaborate esté completamente cargado y visible en pantalla (con la barra de controles inferior visible).
5. **Confirmación en la Terminal:**
   - Vuelve a PowerShell donde verás:
     ```text
     👉 ¿El reproductor está completamente visible en pantalla? Pulsa ENTER para inspeccionar (o escribe "cancel"):
     ```
   - Pulsa **ENTER**.

---

## 3. Salida y Reporte Generado

LectureVault inspeccionará únicamente los elementos visuales y de accesibilidad expuestos por el navegador y mostrará por pantalla un resumen estructurado:

- **Host verificado:** Host exacto saneado (ej. `eu.bbcollab.com`).
- **Contexto de ventana:** `same-tab`, `new-tab` o `popup`.
- **Reproductor detectado:** Indicador de confirmación.
- **Incrustado en iframe:** Indica si el vídeo reside dentro de un marco embebido.
- **Interacción previa requerida:** Si requiere acción manual del usuario antes de reproducir.
- **Controles visibles detectados:**
  - Control de Play/Pause.
  - Indicador de duración y tiempo actual.
  - Selector de velocidad de reproducción (1x, 1.25x, etc.).
  - Botón o selector de Subtítulos / Closed Captions (`CC`).
  - Panel o botón de Transcripción oficial.
  - Opciones visibles de Descarga directa (si están habilitadas por el moderador/profesor).
  - Panel de Chat o Contenido de sesión.
  - Etiquetas de accesibilidad identificadas en los controles.

El reporte se guardará automáticamente en:
`./data/diagnostics/player-capabilities-[timestamp].json`

Y si está habilitado el diagnóstico HTML (`ENABLE_DIAGNOSTICS=true` en `.env`), se guardará una copia saneada del contenedor de controles en:
`./data/diagnostics/player-controls-[timestamp].html`

---

## 4. Pruebas Automatizadas

Puedes ejecutar las pruebas en cualquier momento con:

```powershell
# Pruebas unitarias
npx vitest run

# Pruebas Playwright (incluyendo fixtures sintéticos del reproductor)
npx playwright test

# Compilación TypeScript
npm run build
```
