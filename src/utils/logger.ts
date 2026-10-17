/**
 * LectureVault — Structured logger
 *
 * Wraps pino with redaction of sensitive fields and
 * consistent formatting across the application.
 */

import pino from 'pino';
import type { AppConfig } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';

/** Fields that must never appear in logs */
const REDACTED_PATHS = [
  'password',
  'token',
  'cookie',
  'authorization',
  'credentials',
  'secret',
  'session',
  'mfa',
  'otp',
];

/**
 * Create the application logger.
 * Logs are written to stdout in development (pretty-printed)
 * and can be piped to a file in production.
 */
export function createLogger(config: Pick<AppConfig, 'logLevel' | 'logDir'>): pino.Logger {
  // Ensure log directory exists
  fs.mkdirSync(config.logDir, { recursive: true });

  const targets: pino.TransportTargetOptions[] = [
    // Pretty console output
    {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
      level: config.logLevel,
    },
    // JSON file output
    {
      target: 'pino/file',
      options: {
        destination: path.join(config.logDir, 'lecturevault.log'),
        mkdir: true,
      },
      level: config.logLevel,
    },
  ];

  const logger = pino({
    level: config.logLevel,
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    transport: { targets },
  });

  return logger;
}

/**
 * Create a simple logger with defaults (for testing or early startup).
 */
export function createDefaultLogger(): pino.Logger {
  return createLogger({
    logLevel: 'info',
    logDir: './data/logs',
  });
}
