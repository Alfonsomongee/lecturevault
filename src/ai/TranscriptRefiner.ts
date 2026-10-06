/**
 * Transcript Refiner — Google Gemini AI Studio Integration
 *
 * Filtra el ruido oral, muletillas, pruebas de audio y charlas intrascendentes.
 * Estructura, organiza y sintetiza el contenido académico útil en texto plano y Markdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

export interface TranscriptRefinerOptions {
  apiKey?: string;
  model?: string;
  logger?: Logger;
}

export interface RefinedTranscriptOutput {
  originalLengthChars: number;
  refinedLengthChars: number;
  cleanText: string;
  cleanTxtPath?: string;
  cleanMdPath?: string;
  modelUsed: string;
}

export class TranscriptRefiner {
  private apiKey: string;
  private model: string;
  private logger?: Logger;

  constructor(options?: TranscriptRefinerOptions) {
    this.apiKey = options?.apiKey || process.env['GEMINI_API_KEY'] || '';
    this.model = options?.model || 'gemini-2.5-flash';
    this.logger = options?.logger?.child({ component: 'transcript-refiner' });
  }

  /**
   * Refina y limpia una transcripción en texto sin formato usando Gemini.
   */
  public async refineTranscript(rawText: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        'GEMINI_API_KEY no está configurada. Añádela en tu archivo .env para usar el filtrado inteligente de IA.'
      );
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('La transcripción de entrada está vacía.');
    }

    const systemPrompt = `Eres un asistente experto en síntesis académica universitaria y redacción de apuntes técnicos de ingeniería.
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

3. RIGOR TÉCNICO:
   - Conserva con total exactitud todos los nombres de software, herramientas, fórmulas, porcentajes y fechas.
   - No inventes datos que no aparezcan en la transcripción.
   - Redacta en un tono académico formal, claro, fluido y directo en español.`;

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    this.logger?.info({ model: this.model, inputChars: rawText.length }, 'Enviando transcripción a Gemini AI Studio...');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            parts: [
              {
                text: `A continuación tienes la transcripción en bruto de la clase. Filtra todo el ruido y devuélveme el documento limpio y perfectamente estructurado:\n\n${rawText}`
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2, // Baja temperatura para máxima fidelidad y mínimo invento
        }
      })
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Error en la API de Gemini (${response.status} ${response.statusText}): ${errorBody}`);
    }

    const data = await response.json();
    const refinedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!refinedText) {
      throw new Error('Gemini no devolvió texto en su respuesta.');
    }

    this.logger?.info({ outputChars: refinedText.length }, 'Transcripción refinada recibida de Gemini con éxito');
    return refinedText;
  }

  /**
   * Refina el archivo de transcripción (.txt) y guarda las versiones .clean.txt y .clean.md
   */
  public async refineTranscriptFile(txtFilePath: string): Promise<RefinedTranscriptOutput> {
    const resolvedPath = path.resolve(txtFilePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`El archivo de transcripción no existe: "${resolvedPath}"`);
    }

    const rawContent = fs.readFileSync(resolvedPath, 'utf8');
    const cleanContent = await this.refineTranscript(rawContent);

    const dir = path.dirname(resolvedPath);
    const baseName = path.basename(resolvedPath, path.extname(resolvedPath));

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
    };
  }
}
