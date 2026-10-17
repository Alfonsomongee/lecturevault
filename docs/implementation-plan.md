# LectureVault Implementation Plan (Milestone 1)

## Phase 1: Project Scaffolding

**Description:** Set up the foundational Node.js/TypeScript project structure, configuration files, and essential directories.

**Estimated Files:**
- `package.json`
- `tsconfig.json`
- `.env.example`
- `.gitignore`
- `README.md`

**Key Classes/Interfaces:** N/A (Configuration phase)

**Dependencies Needed:**
- `typescript`, `@types/node`, `ts-node` (Dev)
- `vitest` (Dev)
- `playwright`, `@playwright/test` (Prod/Dev)
- `better-sqlite3`, `@types/better-sqlite3` (Prod/Dev)
- `express`, `@types/express` (Prod/Dev)
- `pino`, `pino-pretty` (Prod)
- `dotenv` (Prod)

**Acceptance Criteria:**
- Project initializes successfully with `npm install`.
- Directory structure matches the specified layout exactly.
- TypeScript compiles without errors in strict mode using ES2022/NodeNext.
- Essential dotfiles are present and correctly configured.

**Risks & Mitigations:**
- **Risk:** Module resolution issues with `NodeNext`.
- **Mitigation:** Ensure proper export maps in `package.json` and consistent use of `.js` extensions in imports where required by standard NodeNext resolution.

## Phase 2: Browser Manager

**Description:** Establish a resilient wrapper around Playwright's persistent Chromium contexts to manage browser lifecycles and user sessions.

**Estimated Files:**
- `src/browser/BrowserManager.ts`
- `src/browser/types.ts`
- `tests/unit/BrowserManager.test.ts`

**Key Classes/Interfaces:**
- `class BrowserManager`: Handles `launchPersistentContext`, context retrieval, and shutdown.
- `interface BrowserConfig`: Defines viewport, headless toggle, data directory.

**Dependencies Needed:**
- `playwright`

**Acceptance Criteria:**
- Can launch a headed or headless persistent Chromium context.
- Profile data is saved to `./data/browser-profile/`.
- Gracefully shuts down on SIGINT/SIGTERM without leaving zombie processes.
- Can detect if the current session is logged in or logged out.
- Provides a utility to take a screenshot on failure and save to `./data/screenshots/`.

**Risks & Mitigations:**
- **Risk:** Persistent context locking if the process crashes.
- **Mitigation:** Implement robust cleanup logic on `process.on('exit')` and signal handlers. Add a force-unlock utility if needed.

## Phase 3: Page Navigator

**Description:** Handle the robust navigation to Collab2 recording pages, accounting for lazy loading, dynamic layouts, and authentication challenges.

**Estimated Files:**
- `src/navigator/PageNavigator.ts`
- `src/navigator/types.ts`
- `tests/e2e/PageNavigator.spec.ts`

**Key Classes/Interfaces:**
- `class PageNavigator`: Manages URL navigation, wait states, and URL validation.
- `enum PageState`: `LOADED`, `EMPTY`, `ERROR`, `AUTH_CHALLENGE`.

**Dependencies Needed:**
- `playwright`

**Acceptance Criteria:**
- Navigates securely only to expected university domains.
- Detects authentication challenges and pauses execution, prompting the user in the console.
- Successfully waits for Collab2's dynamic `div`/`span` structures to load completely.
- Accurately identifies page states (recordings loaded, empty state, error state).

**Risks & Mitigations:**
- **Risk:** Brittle wait conditions leading to timeouts or premature interactions.
- **Mitigation:** Rely on Playwright's auto-waiting features and explicit `waitForSelector` for key stable elements rather than fixed timeouts.

## Phase 4: Recording Extractor

**Description:** Extract structured metadata from the Collab2 DOM, dealing with dynamic, non-tabular layouts.

**Estimated Files:**
- `src/extractor/RecordingExtractor.ts`
- `src/extractor/types.ts`
- `tests/unit/RecordingExtractor.test.ts`

**Key Classes/Interfaces:**
- `class RecordingExtractor`: Parses the DOM and extracts metadata.
- `interface RecordingMetadata`: `{ title, creationDate, duration, playbackLocator }`.

**Dependencies Needed:**
- `playwright` (for locators/evaluation)

**Acceptance Criteria:**
- Correctly parses `div`/`span` structures using ARIA roles or resilient CSS/XPath selectors.
- Extracts title, creation date, duration, and playback link/button.
- Normalizes dates to ISO strings and durations to seconds.
- Handles pagination or lazy-loaded lists if present.
- Implements fallback selectors if the primary DOM structure changes slightly.

**Risks & Mitigations:**
- **Risk:** DOM structure changes frequently, breaking extraction.
- **Mitigation:** Use ARIA attributes and text-based locators where possible, as they are generally more stable than CSS classes. Implement comprehensive unit tests with mock DOM snippets.

## Phase 5: Database Layer

**Description:** Persist extracted recording metadata using a local SQLite database with robust upsert logic.

**Estimated Files:**
- `src/database/DatabaseManager.ts`
- `src/database/schema.sql`
- `tests/unit/DatabaseManager.test.ts`

**Key Classes/Interfaces:**
- `class DatabaseManager`: Handles connection, schema setup, queries, and upserts.
- `interface RecordingRecord`: Maps to the SQLite row.

**Dependencies Needed:**
- `better-sqlite3`

**Acceptance Criteria:**
- SQLite database created at `./data/recordings.db`.
- Schema accurately reflects the `recordings` table requirements.
- Upsert logic successfully inserts new recordings and updates `last_seen_at` for existing ones.
- Safely handles concurrent reads (e.g., from the dashboard) and writes (from the scraper) using WAL mode.

**Risks & Mitigations:**
- **Risk:** Database locking issues.
- **Mitigation:** Enable WAL (Write-Ahead Logging) mode in SQLite pragmas upon connection initialization.

## Phase 6: Dashboard

**Description:** Provide a local-only web interface to view and manage synced recordings.

**Estimated Files:**
- `src/dashboard/DashboardServer.ts`
- `src/dashboard/api.ts`
- `public/index.html`
- `public/styles.css`
- `public/app.js`

**Key Classes/Interfaces:**
- `class DashboardServer`: Configures and starts the Express server.

**Dependencies Needed:**
- `express`

**Acceptance Criteria:**
- Express server binds strictly to `localhost` (127.0.0.1) to prevent external access.
- Serves a static HTML dashboard from `public/`.
- Provides a `GET /api/recordings` endpoint that returns JSON data from the database.
- Dashboard displays a responsive table of recordings with sorting and filtering (new/seen/all).
- Includes a functional "Manual Sync" button (triggering an API endpoint).

**Risks & Mitigations:**
- **Risk:** Security vulnerabilities allowing local network access.
- **Mitigation:** Explicitly bind the Express listener to `127.0.0.1`, not `0.0.0.0`.

## Phase 7: Integration & CLI

**Description:** Tie all components together into a cohesive application with a command-line interface.

**Estimated Files:**
- `src/index.ts`
- `src/cli.ts`
- `src/utils/logger.ts`

**Key Classes/Interfaces:**
- `class Orchestrator` (or main functions): Coordinates Browser, Navigator, Extractor, and Database.

**Dependencies Needed:**
- `pino`, `pino-pretty`

**Acceptance Criteria:**
- `src/index.ts` exposes main entry points.
- CLI supports commands: `sync`, `serve`, `sync-and-serve`.
- Structured logging is implemented across all classes via a shared `pino` logger instance.
- Uncaught exceptions and unhandled rejections are logged cleanly, and the browser is closed gracefully.

**Risks & Mitigations:**
- **Risk:** Zombie Playwright processes on crash.
- **Mitigation:** Wrap the main orchestration logic in a global `try/catch/finally` block that guarantees `BrowserManager.close()` is called.

## Phase 8: Testing & Documentation

**Description:** Ensure system reliability through comprehensive testing and document usage for future maintainability.

**Estimated Files:**
- Various files in `tests/unit/` and `tests/e2e/`
- `docs/architecture.md`
- `docs/threat-model.md`
- Updates to `README.md`

**Key Classes/Interfaces:** N/A

**Dependencies Needed:**
- `vitest`
- `@playwright/test`

**Acceptance Criteria:**
- Unit tests cover DatabaseManager logic, RecordingExtractor parsing (using mock HTML), and Logger utilities.
- Playwright tests verify BrowserManager startup/shutdown and Dashboard basic rendering.
- `README.md` includes clear setup instructions, CLI usage, and an architecture overview.
- All tests pass locally in a single run.

**Risks & Mitigations:**
- **Risk:** Tests are flaky due to reliance on external live Collab2 servers.
- **Mitigation:** E2E tests should mock network requests or use local HTML files where possible to ensure deterministic execution.
