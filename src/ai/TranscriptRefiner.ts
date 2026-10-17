/**
 * Transcript Refiner — Google Gemini AI Studio Integration
 *
 * Filtra el ruido oral, muletillas, pruebas de audio y charlas intrascendentes.
 * Estructura, organiza y sintetiza el contenido académico útil en Markdown,
 * conservando marcas de tiempo [mm:ss] para poder saltar al audio desde el dashboard.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { GeminiClient } from './GeminiClient.js';
import {
  parseWhisperJson,
  toTimestampedText,
  type TranscriptSegment,
} from '../library/transcript-files.js';

/** Bump when the prompt changes so stored notes can be re-generated on demand. */
export const NOTES_PROMPT_VERSION = '2';

/** ~700k chars ≈ 3 h of Spanish speech; beyond this we refuse rather than truncate silently. */
const MAX_INPUT_CHARS = 700_000;

export interface TranscriptRefinerOptions {
  apiKey?: string;
  model?: string;
  logger?: Logger;
  /** Inject a client (tests, shared rate limiting). */
  client?: GeminiClient;
}

export interface RefinedTranscriptOutput {
  originalLengthChars: number;
  refinedLengthChars: number;
  cleanText: string;
  cleanTxtPath?: string;
  cleanMdPath?: string;
  modelUsed: string;
  /** True when the notes were generated from timestamped segments */
  timestamped: boolean;
}

export interface NotesContext {
  title?: string;
  course?: string;
  /** Free-text course glossary to keep spelling of technical terms consistent */
  glossary?: string[];
}

const SYSTEM_PROMPT = `Eres un asistente experto en síntesis académica universitaria y redacción de apuntes técnicos de ingeniería.
Tu objetivo es procesar una transcripción en bruto generada automáticamente por reconocimiento de voz de una clase universitaria y transformarla en un documento de apuntes limpio, riguroso, estructurado y de alto valor para el estudiante.

Instrucciones estrictas:
1. FILTRADO DE RUIDO ORAL:
   - Elimina muletillas ("eh", "este", "bueno", "o sea", "básicamente", "digamos").
   - Elimina repeticiones de palabras, frases cortadas y titubeos.
   - Elimina saludos triviales, comentarios de conexión, comprobaciones de micrófono ("¿se me escucha?", "voy a compartir pantalla", "esperamos a que entren").
   - Elimina pausas y conversaciones intrascendentes que no aporten contenido a la materia.

2. ESTRUCTURA Y ORGANIZACIÓN DEL CONTENIDO:
   Organiza la clase en secciones lógicas y claras utilizando títulos y listas:
   - # [Título de la Clase / Asignatura]
   - ## 1. Resumen Ejecutivo de la Sesión (párrafo sintético con los temas clave tratados)
   - ## 2. Contenido Técnico y Teórico (conceptos explicados, metodologías, herramientas, software como Ansys, Cype, Workbench, métodos de elementos finitos, etc.)
   - ## 3. Criterios de Evaluación y Entregas (desglose exacto de porcentajes de examen final, portafolios, foros, tutorías, software de supervisión como Smowl, plazos y requisitos)
   - ## 4. Preguntas, Dudas y Aclaraciones Importantes (resolución de dudas planteadas por alumnos o advertencias del profesor)
   - ## 5. Conclusiones y Próximos Pasos

3. MARCAS DE TIEMPO:
   - La transcripción incluye marcas [mm:ss] o [h:mm:ss] al inicio de cada bloque.
   - Añade al final de cada título de subsección y de cada viñeta importante la marca del momento en que se explica, con el formato exacto [mm:ss] (o [h:mm:ss] si pasa de una hora). Ejemplo: "### Fase de mallado en Ansys [14:20]".
   - Usa únicamente marcas que existan en la transcripción. No inventes tiempos.

4. RIGOR TÉCNICO:
   - Conserva con total exactitud todos los nombres de software, herramientas, fórmulas, porcentajes y fechas.
   - Escribe las fórmulas en LaTeX entre signos de dólar ($...$ en línea, $$...$$ en bloque).
   - No inventes datos que no aparezcan en la transcripción.
   - Redacta en un tono académico formal, claro, fluido y directo en español.
   - Si una frase es ininteligible o dudosa, omítela en lugar de adivinarla.`;

export class TranscriptRefiner {
  private client: GeminiClient;
  private logger?: Logger;

  constructor(options?: TranscriptRefinerOptions) {
    this.logger = options?.logger?.child({ component: 'transcript-refiner' });
    this.client =
      options?.client ??
      new GeminiClient({
        apiKey: options?.apiKey,
        model: options?.model,
        logger: options?.logger,
      });
  }

  get model(): string {
    return this.client.model;
  }

  /**
   * Refina y limpia una transcripción en texto con Gemini.
   * `rawText` puede llevar marcas [mm:ss] (recomendado) o ser texto plano.
   */
  public async refineTranscript(rawText: string, context: NotesContext = {}): Promise<string> {
    if (!this.client.hasKey) {
      throw new Error(
        'GEMINI_API_KEY no está configurada. Añádela en tu archivo .env para usar el filtrado inteligente de IA.'
      );
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('La transcripción de entrada está vacía.');
    }

    if (rawText.length > MAX_INPUT_CHARS) {
      throw new Error(
        `La transcripción es demasiado larga (${rawText.length} caracteres; máximo ${MAX_INPUT_CHARS}).`
      );
    }

    const header: string[] = [];
    if (context.course) header.push(`Asignatura: ${context.course}`);
    if (context.title) header.push(`Título de la grabación: ${context.title}`);
    if (context.glossary?.length) {
      header.push(`Vocabulario técnico de la asignatura (usa esta ortografía exacta): ${context.glossary.join(', ')}`);
    }

    this.logger?.info({ model: this.model, inputChars: rawText.length }, 'Enviando transcripción a Gemini AI Studio...');

    const refined = await this.client.generateText(
      `${header.length ? header.join('\n') + '\n\n' : ''}A continuación tienes la transcripción en bruto de la clase. Filtra todo el ruido y devuélveme el documento limpio y perfectamente estructurado:\n\n${rawText}`,
      { system: SYSTEM_PROMPT, temperature: 0.2 }
    );

    this.logger?.info({ outputChars: refined.length }, 'Transcripción refinada recibida de Gemini con éxito');
    return refined;
  }

  /** Genera apuntes a partir de segmentos con tiempo (lo que produce faster-whisper). */
  public async refineSegments(segments: TranscriptSegment[], context: NotesContext = {}): Promise<string> {
    return this.refineTranscript(toTimestampedText(segments), context);
  }

  /**
   * Refina el archivo de transcripción (.txt) y guarda las versiones .clean.txt y .clean.md.
   * Si existe el .json hermano, usa los segmentos con marcas de tiempo.
   */
  public async refineTranscriptFile(txtFilePath: string, context: NotesContext = {}): Promise<RefinedTranscriptOutput> {
    const resolvedPath = path.resolve(txtFilePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`El archivo de transcripción no existe: "${resolvedPath}"`);
    }

    const rawContent = fs.readFileSync(resolvedPath, 'utf8');
    const dir = path.dirname(resolvedPath);
    const baseName = path.basename(resolvedPath, path.extname(resolvedPath));

    let input = rawContent;
    let timestamped = false;
    const jsonPath = path.join(dir, `${baseName}.json`);
    if (fs.existsSync(jsonPath)) {
      try {
        const stamped = toTimestampedText(parseWhisperJson(fs.readFileSync(jsonPath, 'utf8')).segments);
        if (stamped.trim()) {
          input = stamped;
          timestamped = true;
        }
      } catch (err) {
        this.logger?.warn({ err }, 'No se pudo leer el JSON de segmentos; se usa el texto plano sin marcas de tiempo');
      }
    }

    const cleanContent = await this.refineTranscript(input, context);

    const cleanTxtPath = path.join(dir, `${baseName}.clean.txt`);
    const cleanMdPath = path.join(dir, `${baseName}.clean.md`);

    fs.writeFileSync(cleanTxtPath, cleanContent, 'utf8');
    fs.writeFileSync(cleanMdPath, cleanContent, 'utf8');

    return {
      originalLengthChars: rawContent.length,
      refinedLengthChars: cleanContent.length,
      cleanText: cleanContent,
      cleanTxtPath,
      cleanMdPath,
      modelUsed: this.model,
      timestamped,
    };
  }
}
