/**
 * Demo data: three courses, five classes with transcripts, notes with timestamps and LaTeX,
 * alerts, flashcards and glossary — plus short synthetic audio so the player and seeking work.
 *
 * Writes only inside the folder it is given (default data/demo) and never touches real data.
 * Run with: npm run demo
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { DatabaseManager } from '../database/DatabaseManager.js';
import { StudyRepository, type AlertInput, type FlashcardInput } from '../database/StudyRepository.js';
import { TranscriptIngestor } from '../library/TranscriptIngestor.js';
import { addDays, localCalendarDate, toIso } from '../study/dates.js';
import { formatClock } from '../utils/time.js';

interface DemoClass {
  id: string;
  course: string;
  title: string;
  daysAgo: number;
  lines: string[];
  audio: boolean;
  notes?: (at: (i: number) => string) => string;
  alerts?: (t: (i: number) => number, base: Date) => AlertInput[];
  cards?: (t: (i: number) => number) => FlashcardInput[];
  glossary?: { term: string; definition: string; line: number }[];
}

const GAP_SECONDS = 11.5;

const CLASSES: DemoClass[] = [
  {
    id: 'simulacion_clase2_mallado',
    course: 'Simulación FEM',
    title: 'Clase 2 · Mallado y condiciones de contorno en Ansys',
    daysAgo: 6,
    audio: true,
    lines: [
      'Buenas tardes a todos, ¿se me escucha bien? Voy a compartir pantalla, esperamos un minuto a que entre la gente.',
      'Vale, empezamos. Hoy vamos a ver el mallado y cómo definir las restricciones en Ansys Workbench antes de lanzar el cálculo.',
      'Recordad que el método de los elementos finitos divide la geometría en elementos pequeños y resuelve un sistema de ecuaciones K por u igual a F.',
      'La matriz K es la matriz de rigidez, u son los desplazamientos nodales y F el vector de fuerzas aplicadas.',
      'Primero la malla: en Ansys se genera desde el módulo Mesh, y lo importante es refinar donde hay concentración de tensiones, por ejemplo en agujeros y entallas.',
      'Una malla demasiado gruesa subestima las tensiones; una demasiado fina dispara el tiempo de cálculo. Hay que hacer un estudio de convergencia de malla.',
      'Para definir las restricciones seleccionáis la cara en el árbol y aplicáis un soporte fijo, Fixed Support, que impide los seis grados de libertad.',
      'Cuidado con esta parte: si dejáis la pieza sin restricciones suficientes el solver os da un error de movimiento de sólido rígido y el cálculo no converge.',
      'Después aplicamos la carga. En el ejemplo de la ménsula ponemos una fuerza de mil newtons en el extremo libre.',
      'La tensión de Von Mises es el criterio que usamos para compararla con el límite elástico del material y obtener el coeficiente de seguridad.',
      'Esto entra en el examen: el estudio de convergencia de malla y cómo se interpreta la tensión de Von Mises. Lo preguntaré seguro.',
      'Sobre la evaluación: la práctica de Ansys pesa un treinta por ciento de la nota final y el examen un cincuenta por ciento.',
      'La entrega de la práctica de Ansys es hasta el día 20 de este mes en el aula virtual, no se admiten entregas fuera de plazo.',
      'El foro de dudas está abierto hasta el viernes, ahí resuelvo todas las preguntas sobre el mallado.',
      'Recordad también que el examen final será con Smowl activado, así que revisad la cámara y el micrófono con tiempo.',
      'Bueno, pues nada más por hoy. Gracias a todos y hasta la próxima semana.',
    ],
    notes: (at) => `# Simulación FEM — Mallado y condiciones de contorno en Ansys

## 1. Resumen Ejecutivo de la Sesión
Se explica cómo generar y refinar la malla en Ansys Workbench, cómo definir las restricciones del modelo y cómo interpretar la tensión de Von Mises. Se concretan los criterios de evaluación y las fechas de entrega. ${at(1)}

## 2. Contenido Técnico y Teórico

### Fundamento del método de los elementos finitos ${at(2)}
La geometría se divide en elementos pequeños y se resuelve el sistema

$$K\\,u = F$$

donde $K$ es la **matriz de rigidez**, $u$ los **desplazamientos nodales** y $F$ el vector de fuerzas aplicadas. ${at(3)}

### Mallado en Ansys ${at(4)}
- Se genera desde el módulo **Mesh**.
- Hay que **refinar donde hay concentración de tensiones** (agujeros, entallas).
- Una malla gruesa subestima las tensiones; una muy fina dispara el tiempo de cálculo. ${at(5)}
- Es imprescindible un **estudio de convergencia de malla**. ${at(5)}

### Restricciones y cargas ${at(6)}
- Se selecciona la cara y se aplica un **Fixed Support**, que impide los seis grados de libertad. ${at(6)}
- Sin restricciones suficientes, el solver da un error de **movimiento de sólido rígido** y no converge. ${at(7)}
- Ejemplo de la ménsula: fuerza de $1000\\,\\text{N}$ en el extremo libre. ${at(8)}

### Criterio de Von Mises ${at(9)}
Se compara la tensión equivalente con el límite elástico para obtener el coeficiente de seguridad:

$$n = \\frac{\\sigma_y}{\\sigma_{VM}}$$

## 3. Criterios de Evaluación y Entregas
- **Práctica de Ansys:** 30 % de la nota final. ${at(11)}
- **Examen:** 50 % de la nota final; entra la convergencia de malla y la tensión de Von Mises. ${at(10)}
- **Entrega de la práctica:** hasta el día 20, en el aula virtual, sin entregas fuera de plazo. ${at(12)}
- El examen final se realiza con **Smowl** activado. ${at(14)}

## 4. Preguntas, Dudas y Aclaraciones Importantes
El foro de dudas sobre mallado permanece abierto hasta el viernes. ${at(13)}

## 5. Conclusiones y Próximos Pasos
Preparar la práctica con un estudio de convergencia y revisar cámara y micrófono para Smowl. ${at(14)}
`,
    alerts: (t, base) => {
      const due = toIso(addDays(localCalendarDate(base), 14));
      const friday = toIso(addDays(localCalendarDate(base), 4));
      return [
        { kind: 'exam', text: 'Entra en el examen: estudio de convergencia de malla e interpretación de Von Mises', quote: 'Esto entra en el examen: el estudio de convergencia de malla y cómo se interpreta la tensión de Von Mises.', t_ms: t(10), confidence: 'high' },
        { kind: 'grading', text: 'Práctica de Ansys 30 % · examen 50 % de la nota final', quote: 'la práctica de Ansys pesa un treinta por ciento de la nota final y el examen un cincuenta por ciento', t_ms: t(11), confidence: 'high' },
        { kind: 'deadline', text: 'Entrega de la práctica de Ansys en el aula virtual (sin prórroga)', quote: 'La entrega de la práctica de Ansys es hasta el día 20 de este mes', t_ms: t(12), due_date: due, date_text: 'hasta el día 20', confidence: 'medium' },
        { kind: 'deadline', text: 'Cierra el foro de dudas sobre mallado', quote: 'El foro de dudas está abierto hasta el viernes', t_ms: t(13), due_date: friday, date_text: 'hasta el viernes', confidence: 'medium' },
        { kind: 'warning', text: 'Sin restricciones suficientes: error de sólido rígido y el cálculo no converge', quote: 'si dejáis la pieza sin restricciones suficientes el solver os da un error de movimiento de sólido rígido', t_ms: t(7), confidence: 'high' },
        { kind: 'warning', text: 'Examen con Smowl: revisar cámara y micrófono con tiempo', quote: 'el examen final será con Smowl activado', t_ms: t(14), confidence: 'high' },
      ];
    },
    cards: (t) => [
      { kind: 'basic', front: '¿Qué representa cada término de K·u = F?', back: 'K: matriz de rigidez · u: desplazamientos nodales · F: vector de fuerzas aplicadas.', tag: 'mef', t_ms: t(3) },
      { kind: 'basic', front: '¿Dónde hay que refinar la malla?', back: 'Donde hay concentración de tensiones: agujeros y entallas.', tag: 'mallado', t_ms: t(4) },
      { kind: 'cloze', front: 'Una malla demasiado gruesa {{c1::subestima}} las tensiones y una demasiado fina {{c2::dispara el tiempo de cálculo}}.', back: '', tag: 'mallado', t_ms: t(5) },
      { kind: 'basic', front: '¿Qué comprueba un estudio de convergencia de malla?', back: 'Que el resultado deja de cambiar de forma significativa al refinar la malla.', tag: 'mallado', t_ms: t(5) },
      { kind: 'basic', front: '¿Qué grados de libertad impide un Fixed Support?', back: 'Los seis: tres traslaciones y tres rotaciones.', tag: 'restricciones', t_ms: t(6) },
      { kind: 'cloze', front: 'Si faltan restricciones, Ansys da un error de {{c1::movimiento de sólido rígido}}.', back: '', tag: 'restricciones', t_ms: t(7) },
      { kind: 'basic', front: '¿Para qué sirve la tensión de Von Mises?', back: 'Se compara con el límite elástico para obtener el coeficiente de seguridad.', tag: 'von_mises', t_ms: t(9) },
      { kind: 'cloze', front: 'El coeficiente de seguridad es $n = {{c1::\\sigma_y / \\sigma_{VM}}}$.', back: '', tag: 'von_mises', t_ms: t(9) },
    ],
    glossary: [
      { term: 'Ansys Workbench', definition: 'Entorno de Ansys para simulación por elementos finitos.', line: 1 },
      { term: 'Fixed Support', definition: 'Restricción que impide los seis grados de libertad de una cara.', line: 6 },
      { term: 'Von Mises', definition: 'Tensión equivalente que se compara con el límite elástico.', line: 9 },
      { term: 'Smowl', definition: 'Software de supervisión del examen mediante cámara y micrófono.', line: 14 },
    ],
  },
  {
    id: 'simulacion_clase1_mef',
    course: 'Simulación FEM',
    title: 'Clase 1 · Introducción al método de los elementos finitos',
    daysAgo: 13,
    audio: false,
    lines: [
      'Buenas tardes. Hoy empezamos la asignatura de simulación con el método de los elementos finitos.',
      'La idea es sustituir un problema continuo por uno discreto formado por nodos y elementos.',
      'Cada elemento tiene unas funciones de forma que interpolan el desplazamiento dentro del elemento.',
      'En la asignatura usaremos Ansys Workbench para las prácticas y la licencia de estudiante es gratuita.',
      'Los elementos más habituales son el tetraedro y el hexaedro en tres dimensiones.',
      'Los hexaedros dan mejores resultados con menos elementos, pero son más difíciles de generar en geometrías complejas.',
      'La asignatura se evalúa con una práctica, un examen final y la participación en el foro.',
      'No olvidéis instalar Ansys antes de la próxima clase, porque la primera práctica empieza la semana que viene.',
    ],
    notes: (at) => `# Simulación FEM — Introducción al método de los elementos finitos

## 1. Resumen Ejecutivo de la Sesión
Presentación de la asignatura y de los conceptos básicos del método de los elementos finitos. ${at(0)}

## 2. Contenido Técnico y Teórico
### Discretización ${at(1)}
El problema continuo se sustituye por uno discreto formado por **nodos** y **elementos**. Cada elemento usa **funciones de forma** para interpolar el desplazamiento. ${at(2)}

### Tipos de elementos ${at(4)}
- Tetraedro y hexaedro en 3D.
- Los hexaedros dan mejores resultados con menos elementos, pero son más difíciles de generar. ${at(5)}

## 3. Criterios de Evaluación y Entregas
Una práctica, un examen final y la participación en el foro. ${at(6)}

## 5. Conclusiones y Próximos Pasos
Instalar Ansys Workbench (licencia de estudiante gratuita) antes de la próxima clase. ${at(7)}
`,
    alerts: (t, base) => [
      { kind: 'warning', text: 'Instalar Ansys antes de la próxima clase: la primera práctica empieza la semana que viene', quote: 'No olvidéis instalar Ansys antes de la próxima clase', t_ms: t(7), due_date: toIso(addDays(localCalendarDate(base), 7)), date_text: 'la próxima clase', confidence: 'low' },
    ],
    cards: (t) => [
      { kind: 'basic', front: '¿Qué hacen las funciones de forma?', back: 'Interpolan el desplazamiento dentro de cada elemento.', tag: 'mef', t_ms: t(2) },
      { kind: 'basic', front: '¿Por qué se prefieren hexaedros a tetraedros?', back: 'Dan mejores resultados con menos elementos, aunque son más difíciles de generar.', tag: 'elementos', t_ms: t(5) },
    ],
    glossary: [{ term: 'Funciones de forma', definition: 'Interpolan el desplazamiento dentro de un elemento.', line: 2 }],
  },
  {
    id: 'estructuras_clase1_cype',
    course: 'Estructuras',
    title: 'Clase 1 · Introducción a CYPE y modelado de pórticos',
    daysAgo: 9,
    audio: true,
    lines: [
      'Buenos días. Hoy nos centramos en CYPE y en cómo modelar un pórtico plano para calcular sus esfuerzos.',
      'Trabajaremos con las suites CYPE 3D y Generador de pórticos, que ya tenéis instaladas en el aula.',
      'Para empezar definimos la geometría: nudos, barras y los materiales con su módulo de elasticidad.',
      'Después asignamos las secciones. Para el acero usaremos perfiles IPE y para el hormigón secciones rectangulares.',
      'Las condiciones de apoyo son fundamentales: un empotramiento coarta los giros y un apoyo articulado no.',
      'El momento flector en una viga biapoyada con carga uniforme es q por L al cuadrado dividido entre ocho.',
      'Cuidado con esta fórmula: el signo del momento cambia en voladizos y es una fuente de errores muy habitual.',
      'La práctica de CYPE pesa un treinta por ciento de la nota y hay que usar las dos suites que hemos visto hoy.',
      'La entrega es el último día de octubre, a través de la plataforma, en un único archivo comprimido.',
      'Esto no entra en el examen: la parte de CYPE se evalúa solo con la práctica, no con examen escrito.',
      'Para terminar, repasad los apuntes y subid vuestras dudas al foro de la asignatura.',
    ],
    notes: (at) => `# Estructuras — Introducción a CYPE y modelado de pórticos

## 1. Resumen Ejecutivo de la Sesión
Se modela un pórtico plano en CYPE: geometría, materiales, secciones y condiciones de apoyo, y se repasa el momento flector de una viga biapoyada. ${at(0)}

## 2. Contenido Técnico y Teórico
### Flujo de trabajo en CYPE ${at(1)}
1. Definir nudos y barras. ${at(2)}
2. Asignar materiales con su módulo de elasticidad. ${at(2)}
3. Asignar secciones: perfiles **IPE** en acero, secciones rectangulares en hormigón. ${at(3)}
4. Definir apoyos: el **empotramiento** coarta los giros; el **apoyo articulado** no. ${at(4)}

### Momento flector de una viga biapoyada ${at(5)}
Para carga uniforme $q$ y luz $L$, el momento máximo en centro de vano es

$$M_{max} = \\frac{q\\,L^{2}}{8}$$

> **Cuidado:** el signo del momento cambia en voladizos; es una fuente de errores muy habitual. ${at(6)}

## 3. Criterios de Evaluación y Entregas
- La práctica de CYPE pesa el **30 %** de la nota y exige usar las dos suites vistas (CYPE 3D y Generador de pórticos). ${at(7)}
- Entrega el último día de octubre, por la plataforma, en un único archivo comprimido. ${at(8)}
- La parte de CYPE **no entra en el examen escrito**. ${at(9)}

## 5. Conclusiones y Próximos Pasos
Repasar apuntes y plantear dudas en el foro. ${at(10)}
`,
    alerts: (t, base) => [
      { kind: 'grading', text: 'Práctica de CYPE: 30 % de la nota; usar CYPE 3D y Generador de pórticos', quote: 'La práctica de CYPE pesa un treinta por ciento de la nota y hay que usar las dos suites', t_ms: t(7), confidence: 'high' },
      { kind: 'deadline', text: 'Entrega de la práctica de CYPE (único archivo comprimido)', quote: 'La entrega es el último día de octubre', t_ms: t(8), due_date: `${localCalendarDate(base).y}-10-31`, date_text: 'el último día de octubre', confidence: 'medium' },
      { kind: 'exam', text: 'CYPE no entra en el examen escrito: se evalúa solo con la práctica', quote: 'Esto no entra en el examen', t_ms: t(9), confidence: 'high' },
      { kind: 'formula', text: 'Cuidado con el signo del momento flector en voladizos', quote: 'el signo del momento cambia en voladizos', t_ms: t(6), confidence: 'high' },
    ],
    cards: (t) => [
      { kind: 'basic', front: '¿Qué diferencia hay entre empotramiento y apoyo articulado?', back: 'El empotramiento coarta los giros; el apoyo articulado los permite.', tag: 'apoyos', t_ms: t(4) },
      { kind: 'cloze', front: 'El momento máximo de una viga biapoyada con carga uniforme es $M = {{c1::qL^2/8}}$.', back: '', tag: 'vigas', t_ms: t(5) },
      { kind: 'basic', front: '¿Qué perfiles se usan para el acero en CYPE?', back: 'Perfiles IPE (el hormigón usa secciones rectangulares).', tag: 'secciones', t_ms: t(3) },
      { kind: 'basic', front: '¿Qué suites exige la práctica de CYPE?', back: 'CYPE 3D y Generador de pórticos.', tag: 'practica', t_ms: t(7) },
    ],
    glossary: [
      { term: 'CYPE 3D', definition: 'Suite de cálculo de estructuras tridimensionales.', line: 1 },
      { term: 'Generador de pórticos', definition: 'Suite para modelar pórticos planos.', line: 1 },
      { term: 'IPE', definition: 'Perfil de acero laminado de ala estrecha.', line: 3 },
    ],
  },
  {
    id: 'estructuras_clase2_acciones',
    course: 'Estructuras',
    title: 'Clase 2 · Combinaciones de acciones y estados límite',
    daysAgo: 2,
    audio: true,
    lines: [
      'Hola a todos. Hoy vamos a ver las combinaciones de acciones y los estados límite últimos y de servicio.',
      'Las acciones se clasifican en permanentes, variables y accidentales, cada una con su coeficiente parcial de seguridad.',
      'Para el estado límite último mayoramos las cargas permanentes con un coeficiente de uno coma treinta y cinco.',
      'Las sobrecargas de uso se mayoran con uno coma cinco, y se combinan con coeficientes de simultaneidad.',
      'En CYPE 3D estas combinaciones se generan de forma automática, pero tenéis que revisar que las hipótesis estén bien definidas.',
      'El estado límite de servicio comprueba flechas y vibraciones, y aquí las cargas no se mayoran.',
      'Muy importante: el examen incluye un problema de combinaciones de acciones, y vale la mitad de la nota del examen.',
      'La fecha del examen es el quince de diciembre, y las tutorías de repaso serán la semana anterior.',
    ],
    notes: (at) => `# Estructuras — Combinaciones de acciones y estados límite

## 1. Resumen Ejecutivo de la Sesión
Clasificación de acciones, coeficientes parciales de seguridad y comprobación de estados límite último y de servicio. ${at(0)}

## 2. Contenido Técnico y Teórico
### Clasificación de acciones ${at(1)}
Permanentes, variables y accidentales, cada una con su coeficiente parcial.

### Estado límite último ${at(2)}
- Cargas permanentes: $\\gamma_G = 1{,}35$. ${at(2)}
- Sobrecargas de uso: $\\gamma_Q = 1{,}5$, combinadas con coeficientes de simultaneidad. ${at(3)}

$$E_d = \\sum \\gamma_G G_k + \\gamma_{Q,1} Q_{k,1} + \\sum \\gamma_{Q,i}\\,\\psi_{0,i} Q_{k,i}$$

### Estado límite de servicio ${at(5)}
Se comprueban **flechas y vibraciones**; las cargas **no se mayoran**.

## 3. Criterios de Evaluación y Entregas
- El examen incluye un problema de combinaciones de acciones que vale la mitad de la nota del examen. ${at(6)}
- Examen el **15 de diciembre**; tutorías de repaso la semana anterior. ${at(7)}

## 5. Conclusiones y Próximos Pasos
Revisar las hipótesis definidas en CYPE 3D antes de fiarse de las combinaciones automáticas. ${at(4)}
`,
    alerts: (t, base) => [
      { kind: 'exam', text: 'Examen: 15 de diciembre', quote: 'La fecha del examen es el quince de diciembre', t_ms: t(7), due_date: `${localCalendarDate(base).y}-12-15`, date_text: 'el quince de diciembre', confidence: 'high' },
      { kind: 'exam', text: 'El examen incluye un problema de combinaciones de acciones (la mitad de la nota)', quote: 'el examen incluye un problema de combinaciones de acciones, y vale la mitad de la nota del examen', t_ms: t(6), confidence: 'high' },
      { kind: 'deadline', text: 'Tutorías de repaso: la semana anterior al examen', quote: 'las tutorías de repaso serán la semana anterior', t_ms: t(7), due_date: `${localCalendarDate(base).y}-12-08`, date_text: 'la semana anterior', confidence: 'low' },
    ],
    cards: (t) => [
      { kind: 'cloze', front: 'En ELU las cargas permanentes se mayoran con $\\gamma_G = {{c1::1{,}35}}$ y las sobrecargas con $\\gamma_Q = {{c2::1{,}5}}$.', back: '', tag: 'elu', t_ms: t(2) },
      { kind: 'basic', front: '¿Qué comprueba el estado límite de servicio?', back: 'Flechas y vibraciones, sin mayorar las cargas.', tag: 'els', t_ms: t(5) },
      { kind: 'basic', front: '¿Cómo se clasifican las acciones?', back: 'Permanentes, variables y accidentales.', tag: 'acciones', t_ms: t(1) },
    ],
    glossary: [
      { term: 'ELU', definition: 'Estado límite último: seguridad frente a rotura.', line: 0 },
      { term: 'ELS', definition: 'Estado límite de servicio: flechas y vibraciones.', line: 5 },
    ],
  },
  {
    id: 'materiales_clase1_traccion',
    course: 'Materiales',
    title: 'Clase 1 · Ensayo de tracción y propiedades mecánicas',
    daysAgo: 1,
    audio: false,
    lines: [
      'Buenas tardes. Hoy hablamos del ensayo de tracción, que es la base para conocer las propiedades mecánicas de un material.',
      'Se estira una probeta normalizada y se registra la fuerza frente al alargamiento.',
      'De ahí sale la curva tensión deformación, con su zona elástica, el límite elástico y la tensión de rotura.',
      'En la zona elástica se cumple la ley de Hooke: la tensión es el módulo de Young por la deformación.',
      'El acero tiene un módulo de Young de aproximadamente doscientos diez gigapascales.',
      'Hay materiales dúctiles, como el acero dulce, y frágiles, como la fundición, que rompen sin deformación plástica apreciable.',
      'Para la próxima clase traed la calculadora, porque haremos un problema de la curva tensión deformación.',
    ],
  },
];

/** 8 kHz 16-bit mono WAV with a soft, voice-like drone so the demo player has something to play. */
export function makeDemoWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.35 * t); // slow "phrasing"
    const tone =
      Math.sin(2 * Math.PI * 140 * t) * 0.5 + Math.sin(2 * Math.PI * 280 * t) * 0.25 + Math.sin(2 * Math.PI * 420 * t) * 0.12;
    data.writeInt16LE(Math.round(tone * envelope * 3200), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export interface SeedResult {
  dataDir: string;
  dbPath: string;
  recordings: number;
}

/** Create (or recreate) the demo library under `dataDir`. */
export function seedDemo(dataDir: string, logger: Logger): SeedResult {
  const root = path.resolve(dataDir);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'audio'), { recursive: true });

  const now = new Date();
  const dbPath = path.join(root, 'lecturevault.db');
  const db = new DatabaseManager(dbPath, logger);

  try {
    // 1. Files first: data/ is the source of truth, SQLite is rebuilt from it
    const durations = new Map<string, number>();
    for (const cls of CLASSES) {
      const dir = path.join(root, 'transcripts', cls.id);
      fs.mkdirSync(dir, { recursive: true });

      const segments = cls.lines.map((text, i) => ({
        id: i,
        start: +(i * GAP_SECONDS).toFixed(3),
        end: +(i * GAP_SECONDS + GAP_SECONDS - 1.2).toFixed(3),
        text,
        avg_logprob: -0.18,
        no_speech_prob: 0.01,
      }));
      const duration = Math.ceil(cls.lines.length * GAP_SECONDS);
      durations.set(cls.id, duration);
      const created = new Date(now.getTime() - cls.daysAgo * 86_400_000);
      created.setHours(10, 0, 0, 0);

      fs.writeFileSync(
        path.join(dir, `${cls.id}.json`),
        JSON.stringify({
          recordingId: cls.id, audioFile: `${cls.id}.wav`, model: 'small', detectedLanguage: 'es',
          audioDurationSeconds: duration, segmentCount: segments.length, timestamp: created.toISOString(), segments,
        }, null, 2)
      );
      fs.writeFileSync(path.join(dir, `${cls.id}.txt`), cls.lines.join('\n'));

      if (cls.notes) {
        const at = (i: number) => `[${formatClock(i * GAP_SECONDS)}]`;
        fs.writeFileSync(path.join(dir, `${cls.id}.clean.md`), cls.notes(at));
      }
      if (cls.audio) fs.writeFileSync(path.join(root, 'audio', `${cls.id}.wav`), makeDemoWav(duration));
    }

    // 2. Library rows + derived data
    const ingestor = new TranscriptIngestor(db, root, logger);
    ingestor.ingestAll();
    const study = new StudyRepository(db.handle);

    for (const cls of CLASSES) {
      const rec = db.getRecordingByTranscriptId(cls.id)!;
      db.setCourse(rec.id, cls.course);
      db.handle.prepare('UPDATE recordings SET title = ?, collab_id = ? WHERE id = ?').run(cls.title, `demo-${cls.id}`, rec.id);
      const t = (i: number) => Math.round(i * GAP_SECONDS * 1000);
      const created = new Date(rec.created_at);

      if (cls.notes) {
        const notes = study.getNotes(rec.id)!;
        study.saveNotes(rec.id, notes.markdown, 'demo', '2');
      }
      if (cls.alerts) study.replaceAlerts(rec.id, cls.alerts(t, created));
      if (cls.cards) study.upsertFlashcards(rec.id, cls.cards(t));
      if (cls.glossary) {
        study.upsertGlossary(rec.id, cls.course, cls.glossary.map((g) => ({ term: g.term, definition: g.definition, t_ms: t(g.line) })));
      }
    }

    // Make the demo feel lived-in: one confirmed alert, one dismissed, some cards already reviewed
    const alerts = study.listAlerts({ includeDismissed: true });
    const examAlert = alerts.find((a) => a.kind === 'exam' && a.text.includes('15 de diciembre'));
    if (examAlert) study.updateAlert(examAlert.id, { confirmed: true });
    const lowAlert = alerts.find((a) => a.confidence === 'low' && a.kind === 'warning');
    if (lowAlert) study.updateAlert(lowAlert.id, { dismissed: true });
    const cards = study.listFlashcards({ limit: 500 });
    cards.slice(0, 4).forEach((c, i) => study.reviewFlashcard(c.id, i !== 1));

    // Classes synced from Collab2 but not captured yet, and one transcribed without AI notes
    const pending = [
      { id: 'demo-collab-modal', title: 'Clase 3 · Análisis modal (pendiente de capturar)', course: 'Simulación FEM', min: 65 },
      { id: 'demo-collab-cargas', title: 'Clase 3 · Cargas de viento y nieve (pendiente de capturar)', course: 'Estructuras', min: 58 },
    ];
    for (const p of pending) {
      db.upsertRecording({ collabId: p.id, title: p.title, createdAt: now.toISOString(), durationSeconds: p.min * 60, playbackUrl: '', course: p.course });
    }
    const materials = db.getRecordingByTranscriptId('materiales_clase1_traccion');
    if (materials) db.updateStatus(materials.collab_id, 'seen');

    return { dataDir: root, dbPath, recordings: db.getAllRecordings().length };
  } finally {
    db.close();
  }
}
