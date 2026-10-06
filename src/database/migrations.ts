/**
 * LectureVault — SQLite schema migrations
 *
 * Versioned with `PRAGMA user_version`. Each migration runs once, inside its
 * own transaction, in order. Never edit a released migration: append a new one.
 *
 * Design rule: files under data/ (audio, whisper JSON) are the source of truth;
 * everything created here is either a rebuildable index (segments, FTS, chunks)
 * or user state (alert confirmations, flashcard reviews) that only lives in SQLite.
 */

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'recordings table (Milestone 1)',
    up: (db) => {
      db.exec(`
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
    },
  },
  {
    version: 2,
    description: 'study copilot: courses, segments + FTS5, notes, alerts, flashcards, glossary, chunks',
    up: (db) => {
      db.exec(`
        ALTER TABLE recordings ADD COLUMN course TEXT NOT NULL DEFAULT '';
        -- Folder name under data/transcripts (and audio file stem) for this recording
        ALTER TABLE recordings ADD COLUMN transcript_id TEXT;
        -- Fingerprint of the stored segments, so re-transcriptions are detected even when counts match
        ALTER TABLE recordings ADD COLUMN segments_hash TEXT;
        CREATE INDEX IF NOT EXISTS idx_recordings_course ON recordings(course);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_transcript ON recordings(transcript_id)
          WHERE transcript_id IS NOT NULL;

        CREATE TABLE segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          idx INTEGER NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          text TEXT NOT NULL,
          avg_logprob REAL,
          no_speech_prob REAL,
          UNIQUE(recording_id, idx)
        );
        CREATE INDEX idx_segments_recording ON segments(recording_id, start_ms);

        CREATE VIRTUAL TABLE segments_fts USING fts5(
          text,
          content='segments',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
          INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
          INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
          INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
        END;

        -- Vocabulary of indexed words, used for typo-tolerant search (Whisper mis-hears jargon)
        CREATE VIRTUAL TABLE segments_vocab USING fts5vocab(segments_fts, 'row');

        CREATE TABLE notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'clean',
          markdown TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          prompt_version TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(recording_id, kind)
        );

        CREATE TABLE alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('exam','deadline','warning','formula','grading')),
          text TEXT NOT NULL,
          quote TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          due_date TEXT,
          date_text TEXT NOT NULL DEFAULT '',
          confidence TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
          confirmed INTEGER NOT NULL DEFAULT 0,
          dismissed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_alerts_recording ON alerts(recording_id);
        CREATE INDEX idx_alerts_due ON alerts(due_date);

        CREATE TABLE flashcards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'basic' CHECK(kind IN ('basic','cloze')),
          front TEXT NOT NULL,
          back TEXT NOT NULL DEFAULT '',
          tag TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          guid TEXT NOT NULL UNIQUE,
          box INTEGER NOT NULL DEFAULT 0,
          reps INTEGER NOT NULL DEFAULT 0,
          due_at TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_flashcards_recording ON flashcards(recording_id);
        CREATE INDEX idx_flashcards_due ON flashcards(due_at);

        CREATE TABLE glossary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          term TEXT NOT NULL,
          definition TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          UNIQUE(recording_id, term)
        );

        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          source TEXT NOT NULL DEFAULT 'transcript' CHECK(source IN ('transcript','notes')),
          start_ms INTEGER NOT NULL DEFAULT 0,
          end_ms INTEGER NOT NULL DEFAULT 0,
          text TEXT NOT NULL,
          embedding BLOB,
          embedding_model TEXT
        );
        CREATE INDEX idx_chunks_recording ON chunks(recording_id);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          text,
          content='chunks',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Apply all pending migrations. Returns the versions that were applied. */
export function runMigrations(db: Database.Database): number[] {
  const current = db.pragma('user_version', { simple: true }) as number;
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
    applied.push(migration.version);
  }

  return applied;
}
