/**
 * LectureVault — Shared type definitions
 */

/** Status of a recording in the local database */
export type RecordingStatus = 'new' | 'seen' | 'processed';

/** Metadata extracted from a Collab2 recording entry */
export interface RecordingMetadata {
  /** Unique identifier from Collab2 (derived from playback URL or DOM id) */
  collabId: string;
  /** Recording title as displayed in the UI */
  title: string;
  /** ISO 8601 date string of when the recording was created */
  createdAt: string;
  /** Duration in seconds */
  durationSeconds: number;
  /** Playback URL or reference */
  playbackUrl: string;
}

/** Recording row as stored in SQLite */
export interface RecordingRow {
  id: number;
  collab_id: string;
  title: string;
  created_at: string;
  duration_seconds: number;
  playback_url: string;
  first_seen_at: string;
  last_seen_at: string;
  status: RecordingStatus;
}

/** Application configuration loaded from environment */
export interface AppConfig {
  lmsBaseUrl: string;
  collabRecordingsPath: string;
  allowedHosts: string[];
  courseIdentifier: string;
  browserProfileDir: string;
  browserHeaded: boolean;
  browserViewportWidth: number;
  browserViewportHeight: number;
  browserTimeoutMs: number;
  databasePath: string;
  dashboardPort: number;
  logLevel: string;
  logDir: string;
  screenshotDir: string;
  diagnosticsDir: string;
  enableDiagnostics: boolean;
  screenshotDiagnostics: boolean;
}

/** Page state detected by the navigator */
export type PageState =
  | 'recordings-loaded'
  | 'empty-state'
  | 'auth-required'
  | 'error'
  | 'unknown';

/** Sync result summary */
export interface SyncResult {
  totalFound: number;
  newRecordings: number;
  updatedRecordings: number;
  errors: string[];
  timestamp: string;
}
