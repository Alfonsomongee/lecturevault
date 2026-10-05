# LectureVault

A local-first academic recording assistant that extracts metadata from
Blackboard Collaborate Ultra (Collab2) recordings and displays them in
a clean local dashboard.

> **Milestone 1**: Metadata extraction and dashboard only. No media
> download, stream inspection, or transcription.

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

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 20.0.0
- npm (comes with Node.js)

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd lecturevault

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your university's LMS URL and course path

# 4. Run sync (opens browser for manual login)
npm run sync

# 5. Start dashboard
npm run serve

# 6. Or do both at once
npm run dev
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

- [x] **Milestone 1**: Metadata extraction and dashboard
- [ ] **Milestone 2**: Manual verification of Collab2 download/subtitle options
- [ ] **Milestone 3**: Media download (if permitted)
- [ ] **Milestone 4**: Transcription via local faster-whisper

## License

Private / Personal Use
