# Guía de Prueba de Concepto Manual: Captura de Audio de 5 Minutos (Hito 3)

Esta guía define las instrucciones para realizar la prueba manual de captura acústica aislada en **Windows** antes de proceder a cualquier automatización o transcripción completa.

---

## 1. Requisitos Previos

1. **Instalación de FFmpeg (en Windows):**
   Abre PowerShell y ejecuta mediante `winget`:
   ```powershell
   winget install Gyan.FFmpeg
   ```
   *(Cierra y vuelve a abrir PowerShell para que el comando `ffmpeg` quede registrado en el PATH).*

2. **OBS Studio:**
   Si deseas utilizar la captura aislada por proceso recomendada:
   ```powershell
   winget install OBSProject.OBSStudio
   ```

---

## 2. Procedimiento de Prueba Manual Paso a Paso

### Paso 1: Configurar la Fuente de Audio en OBS
1. Abre **OBS Studio**.
2. En la sección **Fuentes** (Sources), haz clic en el botón `+` y selecciona **Captura de audio de la aplicación (Application Audio Capture [BETA])**.
3. Selecciona la ventana del navegador donde se reproduce la grabación de Collaborate.
4. En el **Mezclador de audio** (Audio Mixer), **asegúrate de que el Micrófono (Mic/Aux) esté completamente silenciado (mute) o eliminado**. Solo debe estar activo el deslizador de la aplicación del navegador.
5. Ajusta en *Ajustes -> Salida -> Grabación* la ruta hacia la carpeta `data\audio\` de tu proyecto:
   `.\data\audio\`

### Paso 2: Grabar la muestra de 5 Minutos
1. En el reproductor de Collaborate, pulsa **Reproducir**.
2. En OBS, pulsa **Iniciar grabación**.
3. Observa que el vúmetro verde se mueve con la voz del profesor.
4. Deja correr exactamente **5 minutos**.
5. Pulsa **Detener grabación** en OBS.

### Paso 3: Conversión y Normalización con FFmpeg a 16 kHz Mono
En PowerShell dentro del proyecto, ejecuta el script de normalización sobre el archivo grabado (por ejemplo `grabacion_raw.mkv` o `grabacion_raw.wav`):

```powershell
ffmpeg -i .\data\audio\grabacion_raw.mkv -vn -ac 1 -ar 16000 -c:a pcm_s16le .\data\audio\muestra_5min_16khz.wav
```

### Paso 4: Verificación y Escucha Local
1. Abre el archivo resultante `.\data\audio\muestra_5min_16khz.wav` en tu reproductor de audio preferido (Groove Música / Reproductor multimedia de Windows).
2. Comprueba que:
   - La voz del docente se escucha con nitidez y claridad.
   - **No se escucha tu micrófono ni ruidos de teclado.**
   - No hay cortes en el audio.

### Paso 5: Limpieza
Si deseas descartar la muestra después de validarla:
```powershell
Remove-Item .\data\audio\muestra_5min_16khz.wav -Force
```

> **Aviso de Seguridad:** En este hito **no** se ejecuta ninguna transcripción con Whisper ni se automatiza la descarga de flujos de medios.
