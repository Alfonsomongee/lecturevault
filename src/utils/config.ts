/**
 * LectureVault — Configuration loader
 *
 * Loads configuration from environment variables (via .env file)
 * with sensible defaults. Never stores or processes credentials.
 */

import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import type { AppConfig } from '../types.js';

// Load .env file from project root
dotenvConfig();

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${key}: "${raw}"`);
  }
  return parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  throw new Error(`Invalid boolean for ${key}: "${raw}"`);
}

/** Load and validate application configuration */
export function loadConfig(): AppConfig {
  const lmsBaseUrl = envStr('LMS_BASE_URL', 'https://example.blackboard.com');
  
  // Validate URL format
  let lmsHost: string;
  try {
    const parsed = new URL(lmsBaseUrl);
    lmsHost = parsed.hostname;
  } catch {
    throw new Error(`Invalid LMS_BASE_URL: "${lmsBaseUrl}"`);
  }

  // Parse allowed hosts: comma-separated list of exact hosts, defaulting to lmsHost
  const rawAllowedHosts = process.env['ALLOWED_HOSTS'];
  const allowedHosts = rawAllowedHosts
    ? rawAllowedHosts.split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
    : [lmsHost.toLowerCase()];

  // Ensure lmsHost is in allowedHosts
  if (!allowedHosts.includes(lmsHost.toLowerCase())) {
    allowedHosts.push(lmsHost.toLowerCase());
  }

  const config: AppConfig = {
    lmsBaseUrl,
    collabRecordingsPath: envStr('COLLAB_RECORDINGS_PATH', '/ultra/courses'),
    allowedHosts,
    courseIdentifier: envStr('COURSE_IDENTIFIER', 'default-course'),
    browserProfileDir: path.resolve(envStr('BROWSER_PROFILE_DIR', './data/browser-profile')),
    browserHeaded: envBool('BROWSER_HEADED', true),
    browserViewportWidth: envInt('BROWSER_VIEWPORT_WIDTH', 1280),
    browserViewportHeight: envInt('BROWSER_VIEWPORT_HEIGHT', 720),
    browserTimeoutMs: envInt('BROWSER_TIMEOUT_MS', 30000),
    databasePath: path.resolve(envStr('DATABASE_PATH', './data/lecturevault.db')),
    dashboardPort: envInt('DASHBOARD_PORT', 3000),
    logLevel: envStr('LOG_LEVEL', 'info'),
    logDir: path.resolve(envStr('LOG_DIR', './data/logs')),
    screenshotDir: path.resolve(envStr('SCREENSHOT_DIR', './data/screenshots')),
    diagnosticsDir: path.resolve(envStr('DIAGNOSTICS_DIR', './data/diagnostics')),
    enableDiagnostics: envBool('ENABLE_DIAGNOSTICS', false),
    screenshotDiagnostics: envBool('SCREENSHOT_DIAGNOSTICS', false),
    geminiApiKey: process.env['GEMINI_API_KEY']?.trim() || undefined,
  };

  // Validate port range
  if (config.dashboardPort < 1 || config.dashboardPort > 65535) {
    throw new Error(`Invalid DASHBOARD_PORT: ${config.dashboardPort}`);
  }

  return config;
}

export { loadConfig as default };
