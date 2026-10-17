# Selección de Modelo y Tipo de Cómputo de Faster-Whisper

Informe generado con base en los resultados de la evaluación de hardware local de la máquina del usuario (Intel Core Ultra 5 235, 14 núcleos, 16 GB RAM, sin GPU NVIDIA dedicada).

---

## 1. Características del Entorno Detectado

- **CPU:** Intel(R) Core(TM) Ultra 5 235 (14 núcleos lógicos).
- **GPU:** Sin GPU dedicada NVIDIA (sin aceleración CUDA / TensorRT).
- **RAM Total:** ~16 GB (~1.8 GB libres en el momento de la prueba).
- **Disco:** >300 GB libres.
- **Python:** 3.12.10 instalado.
- **FFmpeg:** Pendiente de instalación en el sistema.

---

## 2. Modelos Evaluados para Español Universitario

| Modelo | Tamaño en Disco | Consumo RAM (int8) | Velocidad en CPU | Precisión Español (WER) | Recomendación |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **tiny** | ~75 MB | ~250 MB | Muy rápida (>10x) | Regular (errores en términos técnicos de ingeniería) | Descartado |
| **base** | ~145 MB | ~400 MB | Rápida (~5x-7x) | Buena para lenguaje general | **Recomendado para pruebas iniciales ligeras** |
| **small** | ~480 MB | ~1.0 GB | Equilibrada (~2x-3x) | Muy buena (distingue vocabulario técnico universitario) | **Recomendado como estándar de producción en CPU** |
| **medium** | ~1.5 GB | ~3.0 GB | Lenta en CPU (<1x) | Excelente | No recomendado sin GPU NVIDIA |
| **large-v3** | ~3.1 GB | ~6.0 GB | Muy pesada en CPU | Máxima | No recomendado sin GPU NVIDIA |

---

## 3. Configuración Óptima Recomendada

```python
from faster_whisper import WhisperModel

# Configuración optimizada para Intel Core Ultra 5 (CPU)
model = WhisperModel(
    model_size_or_path="small",  # o "base" si hay saturación de memoria
    device="cpu",
    compute_type="int8",        # Cuantización de 8 bits para máximo rendimiento en CPU
    cpu_threads=8               # Deja núcleos libres para el sistema operativo
)
```

- **Tipo de cómputo:** `int8` (reduce a la mitad el consumo de memoria respecto a `float32` sin pérdida perceptible de precisión).
- **Hilos de CPU:** Limitar a 6 u 8 hilos para evitar congelar el entorno mientras la transcripción procesa una clase completa.
