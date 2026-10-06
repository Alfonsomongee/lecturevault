/**
 * Local Hardware & Environment Assessor
 *
 * Inspects system specifications locally for faster-whisper and FFmpeg:
 * - OS, CPU model, physical and logical cores
 * - Installed RAM
 * - GPU names, NVIDIA detection, nvidia-smi & CUDA availability
 * - Free disk space
 * - FFmpeg availability
 * - Python version
 * - Recommended faster-whisper model and compute type
 *
 * STRICT PRIVACY: NEVER uploads or transmits this information.
 */

import os from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export interface HardwareReport {
  os: {
    platform: string;
    release: string;
    arch: string;
    type: string;
  };
  cpu: {
    model: string;
    logicalCores: number;
    physicalCores?: number;
    speedMhz: number;
  };
  ram: {
    totalBytes: number;
    totalGb: number;
    freeBytes: number;
    freeGb: number;
  };
  gpu: {
    names: string[];
    nvidiaDetected: boolean;
    nvidiaSmiAvailable: boolean;
    cudaAvailable: boolean;
    details?: string;
  };
  disk: {
    freeGb?: number;
    totalGb?: number;
    path: string;
  };
  tools: {
    ffmpegAvailable: boolean;
    ffmpegVersion?: string;
    pythonAvailable: boolean;
    pythonVersion?: string;
  };
  recommendation: {
    whisperModel: string;
    computeType: string;
    device: 'cuda' | 'cpu';
    rationale: string;
  };
}

function runCmd(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export function assessHardware(): HardwareReport {
  // 1. Operating system
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Unknown CPU';
  const logicalCores = cpus.length;
  const speedMhz = cpus[0]?.speed || 0;

  let physicalCores: number | undefined;
  if (process.platform === 'win32') {
    const wmCpu = runCmd('wmic cpu get NumberOfCores /value');
    if (wmCpu) {
      const match = wmCpu.match(/NumberOfCores=(\d+)/);
      if (match && match[1]) physicalCores = parseInt(match[1], 10);
    }
  }

  // 2. RAM
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const totalGb = Math.round((totalBytes / (1024 ** 3)) * 10) / 10;
  const freeGb = Math.round((freeBytes / (1024 ** 3)) * 10) / 10;

  // 3. GPU assessment
  const gpuNames: string[] = [];
  let nvidiaDetected = false;
  let nvidiaSmiAvailable = false;
  let cudaAvailable = false;
  let gpuDetails: string | undefined;

  if (process.platform === 'win32') {
    const wmicGpu = runCmd('wmic path win32_VideoController get name');
    if (wmicGpu) {
      const lines = wmicGpu.split('\n').map(l => l.trim()).filter(l => l && !l.toLowerCase().includes('name'));
      for (const line of lines) {
        gpuNames.push(line);
        if (/nvidia|geforce|quadro|rtx|gtx/i.test(line)) {
          nvidiaDetected = true;
        }
      }
    }
  }

  // Check nvidia-smi
  const smiOutput = runCmd('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader');
  if (smiOutput) {
    nvidiaSmiAvailable = true;
    nvidiaDetected = true;
    gpuDetails = smiOutput;
    // Check CUDA
    const nvccOutput = runCmd('nvcc --version');
    if (nvccOutput || smiOutput.includes('NVIDIA')) {
      cudaAvailable = true;
    }
  }

  // 4. Disk space
  let diskFreeGb: number | undefined;
  let diskTotalGb: number | undefined;
  const targetDir = path.resolve('.');

  try {
    if (fs.statfsSync) {
      const stat = fs.statfsSync(targetDir);
      diskFreeGb = Math.round(((stat.bfree * stat.bsize) / (1024 ** 3)) * 10) / 10;
      diskTotalGb = Math.round(((stat.blocks * stat.bsize) / (1024 ** 3)) * 10) / 10;
    }
  } catch {}

  // 5. Tools (FFmpeg, Python)
  const ffmpegVer = runCmd('ffmpeg -version');
  const ffmpegAvailable = ffmpegVer !== null;
  const ffmpegVersionLine = ffmpegVer ? ffmpegVer.split('\n')[0] : undefined;

  let pythonVer = runCmd('python --version');
  if (!pythonVer) pythonVer = runCmd('py --version');
  const pythonAvailable = pythonVer !== null;

  // 6. Model Recommendation
  let recommendedModel = 'small';
  let recommendedCompute = 'int8';
  let recommendedDevice: 'cuda' | 'cpu' = 'cpu';
  let rationale = '';

  if (nvidiaDetected && (cudaAvailable || nvidiaSmiAvailable)) {
    recommendedDevice = 'cuda';
    if (totalGb >= 16) {
      recommendedModel = 'medium';
      recommendedCompute = 'float16';
      rationale = 'NVIDIA GPU detected with >= 16 GB system RAM. GPU float16 acceleration with model "medium" offers the best Spanish accuracy/speed balance.';
    } else {
      recommendedModel = 'small';
      recommendedCompute = 'float16';
      rationale = 'NVIDIA GPU detected with moderate RAM. Model "small" with float16 is fast, lightweight, and very accurate for Spanish.';
    }
  } else {
    recommendedDevice = 'cpu';
    recommendedCompute = 'int8';
    if (logicalCores >= 8 && totalGb >= 16) {
      recommendedModel = 'small';
      rationale = 'CPU-only execution with 8+ logical threads and ample RAM. Model "small" with int8 quantization provides ~2-3x real-time transcription on CPU with high fidelity.';
    } else {
      recommendedModel = 'base';
      rationale = 'CPU-only execution with limited threads/RAM. Model "base" with int8 is recommended to avoid heavy CPU/memory saturation.';
    }
  }

  return {
    os: {
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      type: os.type(),
    },
    cpu: {
      model: cpuModel,
      logicalCores,
      physicalCores,
      speedMhz,
    },
    ram: {
      totalBytes,
      totalGb,
      freeBytes,
      freeGb,
    },
    gpu: {
      names: gpuNames,
      nvidiaDetected,
      nvidiaSmiAvailable,
      cudaAvailable,
      details: gpuDetails,
    },
    disk: {
      freeGb: diskFreeGb,
      totalGb: diskTotalGb,
      path: targetDir,
    },
    tools: {
      ffmpegAvailable,
      ffmpegVersion: ffmpegVersionLine,
      pythonAvailable,
      pythonVersion: pythonVer || undefined,
    },
    recommendation: {
      whisperModel: recommendedModel,
      computeType: recommendedCompute,
      device: recommendedDevice,
      rationale,
    },
  };
}

export function printHardwareReport(report: HardwareReport): void {
  console.log('\n===============================================================');
  console.log('💻 EVALUACIÓN DE HARDWARE LOCAL Y ENTORNO (FASE B)');
  console.log('===============================================================');
  console.log(`• Sistema Operativo:       Windows (${report.os.release}) [${report.os.arch}]`);
  console.log(`• CPU:                     ${report.cpu.model}`);
  console.log(`• Núcleos:                 ${report.cpu.physicalCores ? `${report.cpu.physicalCores} físicos / ` : ''}${report.cpu.logicalCores} lógicos`);
  console.log(`• Memoria RAM:             ${report.ram.totalGb} GB instalados (${report.ram.freeGb} GB libres)`);

  const gpus = report.gpu.names.length > 0 ? report.gpu.names.join(' | ') : 'No identificada por WMIC';
  console.log(`• GPU(s):                  ${gpus}`);
  console.log(`• NVIDIA Detectada:        ${report.gpu.nvidiaDetected ? '✅ SÍ' : '❌ NO'}`);
  console.log(`• nvidia-smi Disponible:   ${report.gpu.nvidiaSmiAvailable ? '✅ SÍ' : '❌ NO'}`);
  console.log(`• Soporte CUDA:            ${report.gpu.cudaAvailable ? '✅ SÍ' : '❌ NO'}`);
  if (report.gpu.details) {
    console.log(`  Detalle GPU:             ${report.gpu.details}`);
  }

  console.log(`• Espacio en disco libre:  ${report.disk.freeGb !== undefined ? `${report.disk.freeGb} GB libres de ${report.disk.totalGb} GB` : 'N/D'}`);
  console.log(`• FFmpeg disponible:       ${report.tools.ffmpegAvailable ? `✅ SÍ (${report.tools.ffmpegVersion?.substring(0, 30)})` : '❌ NO (necesario para Hito 3)'}`);
  console.log(`• Python disponible:       ${report.tools.pythonAvailable ? `✅ SÍ (${report.tools.pythonVersion})` : '❌ NO (necesario para faster-whisper)'}`);

  console.log('\n---------------------------------------------------------------');
  console.log('🎯 RECOMENDACIÓN PARA FASTER-WHISPER LOCAL:');
  console.log('---------------------------------------------------------------');
  console.log(`• Modelo recomendado:     "${report.recommendation.whisperModel}"`);
  console.log(`• Dispositivo (Device):    ${report.recommendation.device.toUpperCase()}`);
  console.log(`• Tipo de cómputo:         ${report.recommendation.computeType}`);
  console.log(`• Motivo:                  ${report.recommendation.rationale}`);
  console.log('===============================================================\n');
}

// Ejecutar si se invoca directamente desde CLI
if (process.argv[1]?.endsWith('hardware.ts') || process.argv[1]?.endsWith('hardware.js')) {
  const rep = assessHardware();
  printHardwareReport(rep);
}
