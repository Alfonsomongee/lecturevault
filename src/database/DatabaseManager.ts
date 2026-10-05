import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { RecordingMetadata, RecordingRow, RecordingStatus } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';

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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collab_id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        playback_url TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'seen', 'processed'))
      );

      CREATE INDEX IF NOT EXISTS idx_recordings_collab_id ON recordings(collab_id);
      CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
      CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at);
    `);
    this.logger.debug('Database initialized with WAL mode and schema');
  }

  /**
   * Prepare statements for reuse
   */
  private prepareStatements() {
    return {
      upsert: this.db.prepare(`
        INSERT INTO recordings (collab_id, title, created_at, duration_seconds, playback_url, status, first_seen_at, last_seen_at)
        VALUES (@collab_id, @title, @created_at, @duration_seconds, @playback_url, 'new', datetime('now'), datetime('now'))
        ON CONFLICT(collab_id) DO UPDATE SET
          title = excluded.title,
          duration_seconds = excluded.duration_seconds,
          playback_url = excluded.playback_url,
          last_seen_at = datetime('now')
      `),
      getById: this.db.prepare('SELECT * FROM recordings WHERE collab_id = ?'),
      getAll: this.db.prepare('SELECT * FROM recordings ORDER BY created_at DESC'),
      getByStatus: this.db.prepare('SELECT * FROM recordings WHERE status = ? ORDER BY created_at DESC'),
      updateStatus: this.db.prepare('UPDATE recordings SET status = ? WHERE collab_id = ?'),
      countAll: this.db.prepare('SELECT count(*) as count FROM recordings'),
      countByStatus: this.db.prepare('SELECT count(*) as count FROM recordings WHERE status = ?')
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
      playback_url: metadata.playbackUrl
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
