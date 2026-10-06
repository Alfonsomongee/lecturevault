# Study Copilot — how it works and where everything is stored

LectureVault stays **local-first**: your classes live in a folder on your machine, and the dashboard,
search, player, flashcards and calendar work without internet. Gemini is optional and only ever sees
**text**, never audio.

## 1. Pipeline

```
Collab2 player ──capture (browser, digital audio)──▶ WAV 16 kHz mono ──faster-whisper (local)──▶ segments + timestamps
                                                                                           │
                         ┌─────────────────────────────────────────────────────────────────┘
                         ▼
        ingest (npm run ingest / automatic)         study (npm run study / "Generar con IA", needs GEMINI_API_KEY)
        ├─ segments + FTS5 index (instant search)    ├─ notes.md with [mm:ss] and LaTeX
        ├─ link to the Collab2 recording             ├─ alerts: exam / deadline / grading / warning / formula
        └─ RAG chunks                                ├─ flashcards (basic + cloze) — only if their quote is in the transcript
                                                     ├─ glossary → fed back to Whisper as hotwords
                                                     └─ embeddings for semantic search
                         │
                         ▼
        dashboard  http://localhost:3000   ·   exports: Anki, .ics, Obsidian
```

## 2. Storage layout (everything under `data/`, git-ignored)

```
data/
├── lecturevault.db            SQLite (WAL). Metadata, search indexes, notes, alerts, flashcards, glossary, vectors
├── audio/
│   ├── <id>.wav               Captured audio, 16 kHz mono PCM  (~115 MB per hour)  ← expensive: real-time capture
│   └── <id>.opus              Optional small copy for the player (~14 MB/h)  — npm run optimize:audio
├── transcripts/<id>/
│   ├── <id>.json              Whisper segments with start/end + confidence       ← source of truth
│   ├── <id>.txt|.srt|.vtt     Plain text and subtitles
│   └── <id>.clean.md|.txt     AI notes with [mm:ss] timestamps (mirror of the DB copy)
├── models/                    Whisper weights (downloaded once)
├── exports/                   npm run export → anki-*.txt, calendario.ics, obsidian/<course>/*.md
├── browser-profile/ logs/ screenshots/ diagnostics/    (as before)
└── demo/                      npm run demo → a separate throw-away library (never mixed with yours)
```

`<id>` is a safe file stem (`A–Z a–z 0–9 _ -`). The database links each recording to it
(`recordings.transcript_id`), so renaming a class title never breaks anything.

### What is rebuildable and what is precious

| Data | Where | If lost |
| :--- | :--- | :--- |
| Audio (`.wav`) | files | **Expensive**: recapture runs in real time (or faster with `--speed 4`). Keep it. |
| Whisper JSON / TXT / SRT / VTT | files | Re-transcribe from the WAV. |
| Segments, FTS index, chunks | SQLite | `npm run ingest` rebuilds them from the JSON files. |
| Notes, alerts, flashcards, glossary | SQLite + `.clean.md` | `npm run study -- --force` regenerates (costs API calls). |
| **Alert confirmations, dismissed alerts, flashcard review progress, course assignments** | **SQLite only** | **Not rebuildable → back up `lecturevault.db`.** |
| Embeddings | SQLite (BLOB) | Recomputed automatically; costs a few API calls. |

### Sizes (per hour of class, approximate)

| Item | Size |
| :--- | :--- |
| WAV | 115 MB |
| Opus copy | 14 MB |
| Whisper JSON + TXT + SRT/VTT | ~1 MB |
| Notes | ~15 KB |
| Chunks + 768-dim vectors + FTS | ~1 MB |

A degree of ~600 recorded hours ≈ 70 GB of WAV (≈ 9 GB if you keep only Opus) and ~1 GB of database.
Searching and brute-force semantic retrieval over that many chunks (~30 000) still takes milliseconds.

### Backups

* Close the dashboard and copy `data/` (or at least `data/lecturevault.db*` — the `-wal`/`-shm` files belong to it), or
* with the dashboard running, use SQLite's online backup: `sqlite3 data/lecturevault.db ".backup backup.db"`.
* Sync tools (Syncthing, OneDrive, …) are fine for `audio/`, `transcripts/` and `exports/`; avoid syncing a database that is open.

## 3. Commands

| Command | What it does |
| :--- | :--- |
| `npm run capture:and:transcribe -- --course "Simulación FEM"` | Capture + transcribe + index (+ AI if a key is set) |
| `npm run batch:transcribe -- --speed 4 --silent` | Same for the whole queue; course glossary biases Whisper |
| `npm run ingest` | Import `data/transcripts/*` into SQLite (idempotent) |
| `npm run study [-- --id N --force --upgrade-notes]` | Notes, alerts, flashcards, glossary, embeddings |
| `npm run search -- "restricciones Ansys"` | Instant full-text search from the terminal |
| `npm run ask -- "¿Qué peso tenía la práctica de CYPE?"` | Answer with verified citations |
| `npm run export [-- --course X]` | Anki files, `.ics`, Obsidian notes → `data/exports` |
| `npm run optimize:audio` | Opus copies for the player |
| `npm run serve` | Dashboard (imports new transcripts on start) |
| `npm run demo` | Demo library + dashboard on a separate folder |

## 4. Dashboard

* **Biblioteca** — classes grouped by course, study progress per course, what's next, today's review.
* **Clase** — custom audio player (speed, ±10 s, alert markers on the timeline, resume position), synced transcript
  (click a line to seek, doubtful Whisper segments underlined), notes with clickable `[mm:ss]`, KaTeX formulas, TOC,
  alerts (confirm / dismiss / edit date), flashcards, glossary. Shortcuts: `Space`, `←/→`, `J/L`.
* **Búsqueda** (`/` or `Ctrl+K`) — accent-insensitive, prefix, typo-tolerant (ASR errors), notes + transcript, exact minute.
* **Agenda** — month calendar + deadlines + "keep in mind"; `.ics` export (all or only confirmed).
* **Estudiar** — Leitner spaced repetition (1/3/7/21 days), cloze cards, Anki export (basic + cloze).
* **Preguntar** — Q&A over all classes (hybrid BM25 + embeddings, RRF). Every citation is verified against the
  retrieved text; answers without a verifiable quote are rejected. Works without a key (shows the fragments).

## 5. Trust rules for AI output

1. Flashcards and alerts must quote the transcript; quotes that are not found are dropped.
2. Timestamps are re-derived from where the quote was actually said, not trusted from the model.
3. Dates are validated against the class date; ambiguous ("la semana que viene") stay undated for you to decide.
4. Low-confidence items are labelled "dudoso" and link to the exact audio moment.
5. Re-running the AI never deletes your confirmations or review progress.
