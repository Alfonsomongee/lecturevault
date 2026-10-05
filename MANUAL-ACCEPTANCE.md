# Guía de Aceptación Manual — Flujo Real VIU a Collab2

Esta guía describe el procedimiento exacto paso a paso para ejecutar y verificar la prueba de aceptación manual en **Windows (PowerShell)** conectando con el entorno real de la Universidad Internacional de Valencia (**VIU**) y su visor de grabaciones **Collab2**.

> **Nota de Seguridad Crítica:**  
> LectureVault **NUNCA** solicita, lee, autocompleta ni almacena tus credenciales ni códigos MFA. El inicio de sesión se realiza íntegramente de forma manual en la ventana visible de Chromium.  
> La aplicación no descargará archivos multimedia, no inspeccionará flujos protegidos ni automatizará la reproducción en este hito.

---

## 1. Configuración del Entorno (.env)

Crea o edita el archivo `.env` en la raíz del proyecto (`c:\Users\amonge\Documents\antigravity\zealous-babbage\.env`):

```env
# ── Universidad LMS (VIU) ──────────────────────
LMS_BASE_URL=https://campusvirtual.universidadviu.com
COLLAB_RECORDINGS_PATH=/ultra/courses

# Lista estricta de hosts permitidos (sin comodines).
# Incluye el campus de VIU y los dominios de Collab2/Blackboard:
ALLOWED_HOSTS=campusvirtual.universidadviu.com,collab2.bbcollab.com,eu.bbcollab.com

# Identificador de la asignatura para clave compuesta estable
COURSE_IDENTIFIER=viu-master-asignatura-1

# ── Navegador ──────────────────────────────────
BROWSER_PROFILE_DIR=./data/browser-profile
BROWSER_HEADED=true
BROWSER_VIEWPORT_WIDTH=1280
BROWSER_VIEWPORT_HEIGHT=720
BROWSER_TIMEOUT_MS=60000

# ── Base de datos y Dashboard ─────────────────
DATABASE_PATH=./data/lecturevault.db
DASHBOARD_PORT=3000
LOG_LEVEL=info

# ── Diagnóstico Seguro (Opcional) ──────────────
# Guarda una instantánea saneada del DOM de la tabla (sin tokens ni cookies)
ENABLE_DIAGNOSTICS=true
# Guarda captura visual de la tabla (NUNCA de páginas de login)
SCREENSHOT_DIAGNOSTICS=true
DIAGNOSTICS_DIR=./data/diagnostics
```

---

## 2. Ejecución del Modo de Aceptación Guiada

Abre PowerShell en el directorio del proyecto y ejecuta:

```powershell
npm run accept:manual
```

O directamente mediante `tsx`:

```powershell
npx tsx src/index.ts accept-manual
```

---

## 3. Pasos del Operador (Flujo en el Navegador)

1. **Apertura del Navegador:**
   - Se abrirá una ventana de Chromium controlada con tu perfil persistente en `./data/browser-profile/`.
   - Se cargará la URL base configurada (`https://campusvirtual.universidadviu.com`).

2. **Inicio de Sesión Manual:**
   - Introduce tus credenciales universitarias de VIU en la página oficial.
   - Completa el reto MFA / 2FA si te lo solicita tu universidad.
   - La CLI de LectureVault permanecerá a la espera: **no interactuará con el formulario de acceso**.

3. **Navegación al curso y a Collab2:**
   - Una vez dentro del Campus Virtual, dirígete a tu curso o asignatura.
   - Abre la herramienta de sesiones/grabaciones de **Collab2**.
   - Haz clic en el menú o pestaña de grabaciones para que se muestre la tabla de grabaciones con las columnas:
     - **Nombre**
     - **Fecha de creación**
     - **Duración**
     - **Reproducir**
   - *(Aviso:* Si ves un botón con icono de nube, ten en cuenta que solo exporta el listado en CSV, no descarga vídeos).

4. **Confirmación en la Terminal:**
   - Cuando la tabla de grabaciones esté completamente visible en pantalla, vuelve a la ventana de PowerShell.
   - Verás el mensaje:
     ```text
     👉 Is the Collab2 recordings table visible in the browser? Press ENTER to proceed (or type "cancel"):
     ```
   - Pulsa **ENTER** para que LectureVault inicie la extracción.

---

## 4. Qué Hace LectureVault Tras la Confirmación

1. **Validación Estricta de Host:**
   - Comprueba que la URL actual pertenezca a la lista estricta `ALLOWED_HOSTS`. Si el navegador se encuentra en un host no autorizado, aborta la operación inmediatamente.
2. **Detección de la Tabla Collab2:**
   - Localiza la tabla semántica por cabeceras (`Nombre`, `Fecha de creación`, `Duración`, `Reproducir`).
3. **Paginación Automática:**
   - Si existen más de 10 o 25 grabaciones y hay botón de página siguiente ("Siguiente" / "›"), recorrerá las páginas consecutivas sin hacer clics en los enlaces o botones de reproducción.
4. **Almacenamiento Local en SQLite:**
   - Inserta los registros nuevos o actualiza los existentes en `./data/lecturevault.db`.
   - Si no existe un identificador nativo estable en el DOM, calcula la clave compuesta determinista:
     `sha256(COURSE_IDENTIFIER | Nombre | Fecha | Duración)`
5. **Generación de Diagnóstico (si está activado):**
   - Guarda una captura HTML saneada (sin scripts, inputs, tokens o parámetros sensibles) en `./data/diagnostics/snapshot-*.html`.
   - Cierra el navegador de forma limpia.

---

## 5. Verificación en el Dashboard Local

Una vez concluida la extracción, inicia el dashboard:

```powershell
npm run serve
```

Abre en tu navegador local:
[http://localhost:3000](http://localhost:3000)

### Lista de Comprobación de Aceptación:
- [ ] La tabla muestra las columnas correspondientes con los títulos y fechas en formato legible.
- [ ] Las duraciones se calculan correctamente en horas y minutos.
- [ ] Las grabaciones figuran con la etiqueta de estado `NEW`.
- [ ] Al ejecutar una segunda sincronización (`npm run accept:manual`), las grabaciones existentes se actualizan como ya vistas (`SEEN`) **sin crear registros duplicados**.
- [ ] En la carpeta `./data/` se encuentran la base de datos `lecturevault.db` y las capturas de diagnóstico saneadas sin datos privados.

---

## 6. Estado del Hito 1

> **Criterio de finalización:** El Hito 1 no se considerará cerrado de forma definitiva hasta que se ejecute este procedimiento frente a la interfaz real de Collab2 en VIU y se corrobore la extracción de los registros de tu asignatura.
