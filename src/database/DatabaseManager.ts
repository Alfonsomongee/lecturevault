import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { RecordingMetadata, RecordingRow, RecordingStatus } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrations.js';

export class DatabaseManager {
  private db: Database.Database;
  private logger: Logger;

  private stmts: {
    upsert: Database.Statement;
    getById: Database.Statement;
    getAll: Database.Statement;
    getByStatus: Database.Statement;
    updateStatus: Database.Statement;
    countAll: Database.Statement;
    countByStatus: Database.Statement;
    getByRowId: Database.Statement;
    getByTranscriptId: Database.Statement;
    setCourse: Database.Statement;
    setTranscriptId: Database.Statement;
    insertLocal: Database.Statement;
  };

  /**
   * Initialize a new DatabaseManager
   * @param dbPath Path to the SQLite database file
   * @param logger Pino Logger instance
   */
  constructor(dbPath: string, logger: Logger) {
    this.logger = logger;
    
    // Create parent directories if they don't exist
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Open/create the database
    this.db = new Database(dbPath);
    
    this.initialize();
    this.stmts = this.prepareStatements();
  }

  /**
   * Run migrations and set journal mode
   */
  private initialize(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    const applied = runMigrations(this.db);
    this.logger.debug({ applied }, 'Database initialized with WAL mode and schema');
  }

  /** Raw better-sqlite3 handle, shared with the study repositories (same connection). */
  public get handle(): Database.Database {
    return this.db;
  }

  /**
   * Prepare statements for reuse
   */
  private prepareStatements() {
    return {
      upsert: this.db.prepare(`
        INSERT INTO recordings (collab_id, title, created_at, duration_seconds, playback_url, course, status, first_seen_at, last_seen_at)
        VALUES (@collab_id, @title, @created_at, @duration_seconds, @playback_url, @course, 'new', datetime('now'), datetime('now'))
        ON CONFLICT(collab_id) DO UPDATE SET
          title = excluded.title,
          duration_seconds = excluded.duration_seconds,
          playback_url = excluded.playback_url,
          course = CASE WHEN excluded.course != '' THEN excluded.course ELSE recordings.course END,
          last_seen_at = datetime('now')
      `),
      getById: this.db.prepare('SELECT * FROM recordings WHERE collab_id = ?'),
      getAll: this.db.prepare('SELECT * FROM recordings ORDER BY created_at DESC'),
      getByStatus: this.db.prepare('SELECT * FROM recordings WHERE status = ? ORDER BY created_at DESC'),
      updateStatus: this.db.prepare('UPDATE recordings SET status = ? WHERE collab_id = ?'),
      countAll: this.db.prepare('SELECT count(*) as count FROM recordings'),
      countByStatus: this.db.prepare('SELECT count(*) as count FROM recordings WHERE status = ?'),
      getByRowId: this.db.prepare('SELECT * FROM recordings WHERE id = ?'),
      getByTranscriptId: this.db.prepare('SELECT * FROM recordings WHERE transcript_id = ?'),
      setCourse: this.db.prepare('UPDATE recordings SET course = ? WHERE id = ?'),
      setTranscriptId: this.db.prepare('UPDATE recordings SET transcript_id = ? WHERE id = ?'),
      insertLocal: this.db.prepare(`
        INSERT INTO recordings (collab_id, title, created_at, duration_seconds, playback_url, course, transcript_id, status)
        VALUES (@collab_id, @title, @created_at, @duration_seconds, '', @course, @transcript_id, 'processed')
      `),
    };
  }

  /**
   * Insert or update a recording
   * @param metadata The recording metadata to upsert
   * @returns Whether this was a new insertion
   */
  public upsertRecording(metadata: RecordingMetadata): { isNew: boolean } {
    const existing = this.getRecordingByCollabId(metadata.collabId);
    
    this.stmts.upsert.run({
      collab_id: metadata.collabId,
      title: metadata.title,
      created_at: metadata.createdAt,
      duration_seconds: metadata.durationSeconds,
      playback_url: metadata.playbackUrl,
      course: metadata.course ?? '',
    });

    return { isNew: !existing };
  }

  /**
   * Batch upsert wrapped in a transaction
   * @param recordings Array of recording metadata to upsert
   * @returns Number of new and updated recordings
   */
  public upsertMany(recordings: RecordingMetadata[]): { newCount: number; updatedCount: number } {
    let newCount = 0;
    let updatedCount = 0;

    const transaction = this.db.transaction((recs: RecordingMetadata[]) => {
      for (const rec of recs) {
        const { isNew } = this.upsertRecording(rec);
        if (isNew) {
          newCount++;
        } else {
          updatedCount++;
        }
      }
    });

    transaction(recordings);

    return { newCount, updatedCount };
  }

  /**
   * Get all recordings ordered by created_at DESC
   */
  public getAllRecordings(): RecordingRow[] {
    return this.stmts.getAll.all() as RecordingRow[];
  }

  /**
   * Filter recordings by status
   */
  public getRecordingsByStatus(status: RecordingStatus): RecordingRow[] {
    return this.stmts.getByStatus.all(status) as RecordingRow[];
  }

  /**
   * Find single recording by collab_id
   */
  public getRecordingByCollabId(collabId: string): RecordingRow | undefined {
    return this.stmts.getById.get(collabId) as RecordingRow | undefined;
  }

  /**
   * Update recording status
   */
  public updateStatus(collabId: string, status: RecordingStatus): void {
    this.stmts.updateStatus.run(status, collabId);
  }

  /** Find a recording by its numeric primary key */
  public getRecordingById(id: number): RecordingRow | undefined {
    return this.stmts.getByRowId.get(id) as RecordingRow | undefined;
  }

  /** Find the recording linked to a transcript folder / audio stem */
  public getRecordingByTranscriptId(transcriptId: string): RecordingRow | undefined {
    return this.stmts.getByTranscriptId.get(transcriptId) as RecordingRow | undefined;
  }

  /** Assign a recording to a course / subject */
  public setCourse(id: number, course: string): void {
    this.stmts.setCourse.run(course.trim(), id);
  }

  /** Link a recording to its local transcript folder */
  public setTranscriptId(id: number, transcriptId: string): void {
    this.stmts.setTranscriptId.run(transcriptId, id);
  }

  /**
   * Create a recording that exists only locally (captured manually, not listed in Collab2).
   * Its collab_id is namespaced with "local:" so it can never collide with a Collab2 id.
   */
  public createLocalRecording(input: {
    transcriptId: string;
    title: string;
    createdAt: string;
    durationSeconds: number;
    course?: string;
  }): RecordingRow {
    const info = this.stmts.insertLocal.run({
      collab_id: `local:${input.transcriptId}`,
      title: input.title,
      created_at: input.createdAt,
      duration_seconds: Math.round(input.durationSeconds),
      course: input.course ?? '',
      transcript_id: input.transcriptId,
    });
    return this.getRecordingById(Number(info.lastInsertRowid))!;
  }

  /** Distinct courses with how many recordings each one has */
  public getCourses(): { course: string; count: number; totalSeconds: number }[] {
    return this.db
      .prepare(
        `SELECT course, count(*) AS count, COALESCE(sum(duration_seconds), 0) AS totalSeconds
         FROM recordings GROUP BY course ORDER BY course COLLATE NOCASE`
      )
      .all() as { course: string; count: number; totalSeconds: number }[];
  }

  /**
   * Return counts of recordings by status
   */
  public getStats(): { total: number; new: number; seen: number; processed: number } {
    const total = (this.stmts.countAll.get() as { count: number }).count;
    const newCount = (this.stmts.countByStatus.get('new') as { count: number }).count;
    const seenCount = (this.stmts.countByStatus.get('seen') as { count: number }).count;
    const processedCount = (this.stmts.countByStatus.get('processed') as { count: number }).count;

    return {
      total,
      new: newCount,
      seen: seenCount,
      processed: processedCount
    };
  }

  /**
   * Close the database connection
   */
  public close(): void {
    this.db.close();
  }
}
