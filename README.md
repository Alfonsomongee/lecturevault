# LectureVault

A local-first academic recording assistant that extracts metadata from
Blackboard Collaborate Ultra (Collab2) recordings and displays them in
a clean local dashboard.

Beyond metadata, LectureVault now captures the audio of a class, transcribes it
**locally** (faster-whisper) and turns it into a personal study campus: interactive
notes with timestamps, instant search, exam/deadline alerts with a calendar, Anki
flashcards and a Q&A assistant that answers with verified quotes from your classes.
See [docs/study-copilot.md](docs/study-copilot.md) for how it works and where everything is stored.

```bash
npm run demo     # try the whole dashboard with sample classes (separate folder, no setup)
```

---

## Features

- 🎓 **Persistent browser session** — Chromium with a local profile so
  you only log in once
- 🔒 **Zero credential storage** — The app never requests, stores, logs,
  or hardcodes any credentials
- 📋 **Automatic metadata extraction** — Title, date, duration, and
  playback link from Collab2 recordings
- 💾 **SQLite storage** — Local database tracks new vs. previously
  seen recordings
- 📊 **Local dashboard** — Clean web UI with filtering, sorting, and
  stats (localhost only)
- 📝 **Structured logging** — JSON logs with sensitive field redaction
- 📸 **Screenshots on failure** — Automatic capture for debugging
- 🎧 **Study campus** — player with alert markers, synced transcript, notes with clickable `[mm:ss]` + formulas
- 🔎 **Global search** — FTS5, accent/typo tolerant, jumps to the exact minute
- ⚠️ **Critical alerts + calendar** — exams, deadlines, grading, warnings → `.ics`
- 🃏 **Flashcards** — spaced repetition in the dashboard and Anki export (basic + cloze)
- 💬 **Ask your classes** — hybrid retrieval with verified citations

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 20.0.0
- npm (comes with Node.js)
- [Python](https://www.python.org/) 3.10 - 3.12 (for local speech-to-text with `faster-whisper`)
- [FFmpeg](https://ffmpeg.org/) (e.g. `winget install Gyan.FFmpeg` on Windows)

## Quick Start (New Machine Setup)

```bash
# 1. Clone the repository
git clone <repo-url>
cd lecturevault

# 2. Install Node.js dependencies
npm install

# 3. Create Python virtual environment and install faster-whisper
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 4. Configure environment variables
cp .env.example .env
# Edit .env with your LMS URL, course identifier, and allowed hosts

# 5. Build project
npm run build

# 6. Capture and transcribe a class
npm run capture:and:transcribe
```

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Description | Default |
|----------|-------------|---------|
| `LMS_BASE_URL` | Your university's Blackboard URL | `https://example.blackboard.com` |
| `COLLAB_RECORDINGS_PATH` | Path to recordings page | `/ultra/courses` |
| `BROWSER_HEADED` | Show browser window | `true` |
| `DASHBOARD_PORT` | Dashboard port (localhost only) | `3000` |
| `LOG_LEVEL` | Log verbosity | `info` |
| `GEMINI_API_KEY` | Optional: notes, alerts, flashcards, Q&A | — |
| `DATA_DIR` | Root for audio/transcripts/exports | `./data` |

See [.env.example](.env.example) for all options.

## Usage

### Commands

```bash
# Sync: Open browser, navigate to Collab2, extract recordings
npm run sync

# Serve: Start the dashboard (no browser)
npm run serve

# Both: Sync then start dashboard
npm run dev

# Study copilot (see docs/study-copilot.md)
npm run ingest                 # import data/transcripts into SQLite
npm run study                  # notes, alerts, flashcards (needs GEMINI_API_KEY)
npm run search -- "Von Mises"  # instant full-text search
npm run ask -- "¿Qué entra en el examen?"
npm run export                 # Anki, .ics, Obsidian → data/exports
npm run demo                   # sample library + dashboard
```

### First Run

1. Run `npm run sync` — A Chromium browser window opens
2. Navigate to your university's login page and log in manually
3. The app detects authentication and proceeds to extract recordings
4. Recording metadata is saved to the local SQLite database
5. Run `npm run serve` and open http://localhost:3000

### Subsequent Runs

The browser profile persists your session. If the session expires, the
app will detect it and wait for you to re-authenticate.

## Project Structure

```
src/
├── index.ts              # Main entry point / CLI
├── types.ts              # Shared TypeScript interfaces
├── browser/
│   └── BrowserManager.ts # Playwright persistent context
├── navigator/
│   └── PageNavigator.ts  # Page state detection & navigation
├── extractor/
│   └── RecordingExtractor.ts # DOM scraping for metadata
├── database/
│   └── DatabaseManager.ts # SQLite storage layer
├── dashboard/
│   └── DashboardServer.ts # Express server + API
└── utils/
    ├── config.ts          # Environment config loader
    └── logger.ts          # Structured pino logger
public/
└── index.html             # Dashboard UI
tests/
├── unit/                  # vitest unit tests
└── e2e/                   # Playwright E2E tests
docs/
├── architecture.md
├── threat-model.md
├── implementation-plan.md
└── test-plan.md
data/                      # (gitignored) runtime data
├── browser-profile/       # Chromium profile
├── lecturevault.db        # SQLite database
├── logs/                  # Application logs
└── screenshots/           # Failure screenshots
```

## Testing

```bash
# Unit tests
npm test

# Unit tests (watch mode)
npm run test:watch

# E2E tests
npm run test:e2e

# Type checking
npm run lint
```

## Security

- **No credentials**: The app never touches passwords, tokens, or MFA codes
- **Read-only browsing**: Never submits forms, modifies content, or sends messages
- **Localhost only**: Dashboard is bound to 127.0.0.1
- **Log redaction**: Sensitive fields are automatically redacted
- **URL sanitization**: Query parameters stripped from logged URLs
- **Gitignored data**: Browser profiles, database, screenshots, and logs
  are excluded from version control

See [docs/threat-model.md](docs/threat-model.md) for the full security analysis.

## Milestone Roadmap

- [x] **Milestone 1**: Metadata extraction and dashboard (accepted against real Collab2)
- [x] **Milestone 2**: Read-only player capability inspection & sanitization
- [x] **Milestone 3**: In-browser digital audio capture pipeline (zero mic, FFmpeg 16kHz mono normalization)
- [x] **Milestone 4**: Local-only faster-whisper speech-to-text proof of concept (TXT/SRT/VTT/JSON, auto-stop)
- [x] **Milestone 5**: Study copilot — timestamped notes, FTS5 search, alerts + calendar, flashcards, RAG Q&A, campus dashboard

## License
 
MIT License. See [LICENSE](LICENSE) for details.
