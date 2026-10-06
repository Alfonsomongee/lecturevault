# Comparativa de Opciones de Captura de Audio Local en Windows

Para el **Hito 3**, se evalúan tres métodos para capturar exclusivamente el audio que reproduce el navegador en Windows, sin interceptar tráfico de red ni reutilizar URLs privadas.

---

## 1. Tabla Comparativa

| Criterio | Opción A: OBS Studio (Application Audio Capture) | Opción B: Windows WASAPI Loopback (C++ / Node-addon) | Opción C: Dispositivo Virtual (VB-CABLE) |
| :--- | :--- | :--- | :--- |
| **Aislamiento por aplicación** | ✅ **Excelente** (Captura solo el ejecutable de Chromium sin ruidos de Windows ni Teams) | ⚠️ **Complejo** (WASAPI por defecto captura todo el endpoint de altavoces a menos que se use `AUDIOCLIENT_ACTIVATION_PARAMS` en Win10/11) | ⚠️ **Moderado** (Requiere redirigir manualmente el dispositivo de salida en la configuración de Windows) |
| **Exclusión de micrófono** | ✅ **Garantizado** (OBS permite mutear o no agregar fuentes de entrada de micro) | ✅ **Garantizado** (Se escucha solo el búfer de salida) | ⚠️ **Riesgo de mezcla** si el dispositivo virtual se comparte |
| **Facilidad de prueba manual** | ✅ **Inmediata** (UI gráfica interactiva, control visual de vúmetros y niveles de volumen) | ❌ **Baja** (Requiere compilar binarios nativos o módulos Node con herramientas de compilación de Windows) | ⚠️ **Media** (Requiere instalar un controlador de terceros en el sistema) |
| **Dependencias del sistema** | OBS Studio instalado en Windows | Visual Studio Build Tools, SDK de Windows | Driver de audio de terceros (requiere permisos de administrador) |
| **Automatización por WebSocket** | ✅ **Sí** (vía `obs-websocket` oficial integrado en OBS 28+) | ✅ **Sí** (vía API interna de Node.js) | ⚠️ Parcial |

---

## 2. Recomendación Técnica

Se **recomienda la Opción A: OBS Application Audio Capture (BETA/Process-specific)** para la primera prueba de concepto manual por las siguientes razones:

1. **Seguridad y Aislamiento:** Utiliza la API nativa de captura de audio por proceso de Windows 10/11 sin necesidad de capturar los altavoces globales ni tocar el micrófono.
2. **Inspección visual inmediata:** El usuario ve exactamente el vúmetro de volumen moviéndose durante la clase, verificando que el audio se está recibiendo antes de finalizar la grabación.
3. **Cero inyección de DLLs:** No inyecta código en el navegador ni altera las políticas de seguridad de Chromium.
4. **Exportación limpia:** Permite grabar directamente a un archivo de audio/vídeo local que luego FFmpeg convierte a formato mono de 16 kHz.
