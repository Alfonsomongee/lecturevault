# LectureVault Test Plan (Milestone 1)

This document outlines the testing strategy and specific test cases for the first milestone of LectureVault, a local-first academic recording assistant.

## 1. Testing Strategy Overview

The testing approach for LectureVault relies on a mix of automated and manual testing to ensure reliability while dealing with the constraints of authenticated third-party systems.

- **Unit tests (vitest)**: Focus on pure logic, database operations, and data normalization. These should run fast and in isolation.
- **Integration tests (vitest)**: Verify component interactions and API endpoints (Express + better-sqlite3).
- **E2E tests (Playwright)**: Automate browser interactions, dashboard UI testing, and overall application flow.
- **Manual tests**: Required for testing the university login flow and Collab2 detection, as these cannot be automated due to strict authentication and CAPTCHA constraints.

## 2. Unit Tests

### DatabaseManager (`better-sqlite3`)
- Verify schema creation on the first run.
- Insert a new recording.
- Upsert an existing recording (ensure `last_seen_at` is updated, but `first_seen_at` is preserved).
- Query all recordings.
- Query recordings by status (new/seen/processed).
- Handle duplicate `collab_id` gracefully without crashing.
- Verify database file creation in the configured path.

### RecordingExtractor
- Parse a well-formed recording entry from a mock HTML structure.
- Handle missing titles gracefully (provide a fallback or log a warning).
- Handle missing duration gracefully.
- Handle missing date gracefully.
- Normalize various date formats to a standard timestamp or ISO string.
- Normalize duration strings (e.g., '1h 23m', '1:23:00') to total seconds.
- Return an empty array when parsing an empty page.
- Handle a malformed DOM gracefully (ensure no application crash).

### Config / Environment
- Load configuration from a `.env` file.
- Fall back to default values when `.env` is missing.
- Validate required fields (throw an error if missing).
- Reject invalid port numbers (e.g., out of range, non-numeric).
- Reject invalid directory paths.

### Logger
- Verify structured JSON output format.
- Test appropriate log levels (info, warn, error, debug).
- Ensure sensitive data redaction (e.g., stripping passwords or tokens).
- Create and verify child loggers.

## 3. Integration Tests

### Dashboard API (Express)
- `GET /api/recordings` returns a valid JSON array.
- `GET /api/recordings` returns an empty array with an empty database.
- `GET /api/recordings` filters correctly by status.
- `GET /api/recordings` sorts correctly by date.
- `GET /health` returns a 200 OK status.
- Ensure the Dashboard serves static HTML correctly on the root route.
- Verify CORS headers restrict access to `localhost` only.

### Sync Pipeline
- Verify new recordings are inserted correctly into the database.
- Verify existing recordings are updated (only `last_seen_at` changes).
- Ensure status transitions (e.g., new -> processed) work correctly across components.

## 4. E2E Tests (Playwright)

### Browser Manager
- Launch Chromium with a persistent browser context.
- Create the profile directory if it does not exist.
- Close the browser gracefully upon completion.
- Take and save a screenshot on a simulated failure.

### Dashboard UI
- Verify the page loads with the correct title.
- Display an empty state message when no recordings exist.
- Ensure the recordings table renders with mock data.
- Verify filter controls work (e.g., show only 'new').
- Verify sort controls work (e.g., sort by date).
- Ensure the "Sync" button triggers the appropriate API call.
- Check responsive layout on desktop and mobile viewports.

## 5. Manual Test Procedures

Due to authentication restrictions, the following flows must be tested manually:
- Complete the university login flow.
- Verify Collab2 recordings page detection once logged in.
- Test session expiry handling (e.g., what happens when the cookie expires).
- Test the re-authentication flow.

## 6. Test Data

- **Mock recording entries**: Provide varied formats to test extraction robustly.
- **Edge cases**: Test empty strings, special characters, and very long titles.
- **Mock HTML fixtures**: Maintain static HTML files representing the Collab2 DOM structure to feed into the extractor tests.

## 7. Coverage Targets

- **Unit tests**: >80% line coverage.
- **Integration tests**: Coverage of all API endpoints.
- **E2E tests**: Coverage of critical user paths on the dashboard.

## 8. CI/CD Considerations

- Ensure automated tests run without requiring university credentials.
- Use mock-based testing for all authenticated flows during CI.
- Configure CI to upload screenshot artifacts from failed Playwright tests for easier debugging.

## Test Matrix

| Component | Test Type | Tools | Target Scenarios | Priority |
| :--- | :--- | :--- | :--- | :--- |
| DatabaseManager | Unit | vitest | Schema init, CRUD ops, Upsert, Duplicates | High |
| RecordingExtractor | Unit | vitest | DOM parsing, Normalization, Missing fields, Malformed HTML | High |
| Config | Unit | vitest | Env parsing, Validation, Defaults | Medium |
| Logger | Unit | vitest | JSON structure, Redaction, Levels | Low |
| API Endpoints | Integration | vitest + supertest | GET recordings, Health check, Filters, CORS | High |
| Sync Pipeline | Integration | vitest | End-to-end sync, Status transitions | High |
| BrowserManager | E2E | Playwright | Context persistence, Profile creation, Failure screenshots | Medium |
| Dashboard UI | E2E | Playwright | Rendering, Filtering, Sorting, Sync button | High |
| Auth & Detection | Manual | N/A | Login flow, Session expiry, Page detection | High |
