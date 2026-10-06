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
  geminiApiKey?: string;
  browserChannel?: string;
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

/**
 * Read-only playback, subtitle, transcript, and download capabilities
 * detected in the Collab2 / Collaborate playback UI.
 */
export interface PlayerCapabilities {
  /** Detected sanitized host (e.g. eu.bbcollab.com) */
  sanitizedHost: string;
  /** Presentation window context: 'same-tab' | 'new-tab' | 'popup' */
  windowContext: 'same-tab' | 'new-tab' | 'popup';
  /** Whether a recognized video/audio player container was detected */
  playerDetected: boolean;
  /** Whether the player resides inside an iframe */
  isEmbeddedInIframe: boolean;
  /** Whether user interaction (click play) is required before media plays */
  requiresUserInteractionToPlay: boolean;
  /** Visible Play / Pause button or control */
  hasPlayPauseControl: boolean;
  /** Visible duration and current playback time display */
  hasTimeDisplay: boolean;
  visibleDurationText?: string;
  visibleCurrentTimeText?: string;
  /** Visible playback speed selector (1x, 1.25x, etc.) */
  hasPlaybackSpeedControl: boolean;
  /** Visible Closed Captions (CC) or subtitle toggle/selector */
  hasClosedCaptionsControl: boolean;
  /** Subtitle status statement */
  subtitleStatus: string;
  /** Visible transcript panel, tab, or button */
  hasTranscriptPanelOrButton: boolean;
  /** Visible official download button or menu item */
  hasDownloadOption: boolean;
  downloadLabelOrType?: string;
  /** Visible chat or session content / materials options */
  hasChatOrSessionContentOption: boolean;
  /** Any accessibility notes or labels discovered on player controls */
  accessibilityLabels: string[];
}

/** Inspection result report */
export interface PlayerInspectionReport {
  timestamp: string;
  capabilities: PlayerCapabilities;
  diagnosticFilePath?: string;
  screenshotPath?: string;
  warnings: string[];
}

