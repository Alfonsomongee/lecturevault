/**
 * CLI wrapper for TranscriptRefiner
 * Usage:
 *   npx tsx src/ai/refine-cli.ts --input data/transcripts/<id>/<id>.txt
 */

import { loadConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { TranscriptRefiner } from './TranscriptRefiner.js';
import path from 'node:path';
import fs from 'node:fs';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);

  const args = process.argv.slice(2);
  let inputFile = '';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--input' || args[i] === '-i') && args[i + 1]) {
      inputFile = args[i + 1]!;
      i++;
    }
  }

  if (!inputFile) {
    // If no file given, look for the most recently modified .txt in data/transcripts
    const transcriptsDir = path.resolve('data', 'transcripts');
    if (fs.existsSync(transcriptsDir)) {
      const candidates: { path: string; mtime: number }[] = [];
      const scanDir = (dir: string) => {
        for (const item of fs.readdirSync(dir)) {
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            scanDir(fullPath);
          } else if (item.endsWith('.txt') && !item.endsWith('.clean.txt')) {
            candidates.push({ path: fullPath, mtime: stat.mtimeMs });
          }
        }
      };
      scanDir(transcriptsDir);
      candidates.sort((a, b) => b.mtime - a.mtime);
      if (candidates.length > 0 && candidates[0]) {
        inputFile = candidates[0].path;
      }
    }
  }

  if (!inputFile || !fs.existsSync(inputFile)) {
    console.error('\n❌ Error: No se especificó archivo de entrada válido.');
    console.error('Uso: npm run refine:transcript -- --input "data/transcripts/<id>/<id>.txt"\n');
    process.exit(1);
  }

  console.log('\n===============================================================');
  console.log('✨ LECTUREVAULT — REFINADOR DE TRANSCRIPCIONES CON GEMINI');
  console.log('===============================================================');
  console.log(`• Archivo original:  ${inputFile}`);

  const refiner = new TranscriptRefiner({
    apiKey: config.geminiApiKey,
    logger,
  });

  console.log('⏳ Enviando a Gemini para filtrar ruido, muletillas y estructurar...');
  const start = Date.now();
  const output = await refiner.refineTranscriptFile(inputFile);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n===============================================================');
  console.log(`✅ APUNTES LIMPIOS Y ESTRUCTURADOS GENERADOS (${elapsed}s)`);
  console.log('===============================================================');
  console.log(`• Modelo:           ${output.modelUsed}`);
  console.log(`• Caracteres orig:  ${output.originalLengthChars}`);
  console.log(`• Caracteres limpios: ${output.refinedLengthChars}`);
  console.log(`• Guardado en:`);
  console.log(`  - Texto plano:    ${output.cleanTxtPath}`);
  console.log(`  - Markdown:       ${output.cleanMdPath}`);
  console.log('===============================================================\n');

  console.log('📖 VISTA PREVIA DE LOS APUNTES GENERADOS:\n');
  console.log(output.cleanText.slice(0, 800) + (output.cleanText.length > 800 ? '\n\n[... Ver archivo completo para el resto ...]' : ''));
  console.log('\n===============================================================\n');
}

main().catch((err) => {
  console.error('\n❌ Error refinando transcripción:', err.message);
  process.exit(1);
});
