# LectureVault Threat Model

## 1. Overview and Scope

This document outlines the threat model for **LectureVault**, a local-first academic recording assistant. LectureVault is designed to help students organize metadata (title, date, duration, playback links) of academic recordings from their university Learning Management System (LMS). 

The application utilizes Node.js, TypeScript, Playwright (with a visible Chromium persistent context), and SQLite. It operates entirely locally, utilizing an Express server bound to localhost to provide a dashboard.

**In Scope:**
* The local Node.js/Express application.
* The Playwright automation scripts.
* Local SQLite database storage.
* Local file storage (screenshots, logs, browser profile).
* Interactions with the local file system.

**Out of Scope:**
* The security of the university LMS infrastructure.
* The security of the host operating system (assumed to be managed by the user).
* Physical access to the user's machine.
* Network security of the user's local network (beyond binding services locally).

## 2. Assets Inventory

| Asset | Description | Sensitivity | Location |
| :--- | :--- | :--- | :--- |
| **Browser Profile** | Playwright persistent Chromium profile. Contains session cookies, local storage, cached data, and potentially active session tokens for the university LMS. | High | `./data/browser-profile/` |
| **SQLite Database** | Stores extracted lecture metadata (titles, dates, durations, playback URLs). | Low/Medium | `./data/lecturevault.sqlite` |
| **Screenshots** | Captured on automation failure. May contain sensitive page content, user grades, personal information, or LMS UI elements. | High | `./data/screenshots/` |
| **Logs** | Application logs detailing automation progress, errors, and system events. | Medium | `./data/logs/` |
| **Source Code** | The Node.js/TypeScript application code. | Low | Project Directory |

## 3. Trust Boundaries

1.  **User Machine (Internal):** The boundary between the LectureVault application and the underlying host operating system. The application implicitly trusts the local file system and OS-provided resources.
2.  **University LMS (External):** The boundary between the Playwright browser and the remote university servers. The application treats data received from the LMS as potentially untrusted (requiring parsing and validation), but relies on the user's manual authentication to establish a trusted session within the browser.
3.  **Local Network (External to App):** The boundary between the local Express dashboard and the local network. The dashboard is intended *only* for the host machine.

## 4. STRIDE Analysis

| Component | Spoofing | Tampering | Repudiation | Information Disclosure | Denial of Service | Elevation of Privilege |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Browser Context** | N/A (Manual Login) | Local profile tampering | N/A | Session theft, cookie extraction | Profile corruption | N/A |
| **SQLite DB** | N/A | Direct file modification, SQLi | N/A | Unauthorized local read | Corrupt DB file | N/A |
| **Express Dashboard** | Local spoofing (unlikely) | N/A | N/A | Exposing metadata locally, XSS | App crash | CSRF (unlikely on localhost) |
| **Playwright Scripts**| N/A | Script modification | Log tampering | Screenshot/Log exposure | Resource exhaustion (infinite loop) | Accidental LMS writes |

## 5. Attack Surface Analysis

The primary attack surfaces are:
1.  **Local File System:** Directory containing the browser profile, database, screenshots, and logs. Any local process with user privileges can access these files.
2.  **Express Dashboard (Local Network Interface):** The port exposed by the local Express server. While intended to be localhost-only, misconfiguration could expose it to the local network.
3.  **Playwright Browser Instance:** The visible Chromium instance. Malicious extensions (if allowed) or user actions during automation could compromise the session.
4.  **Extracted Data (Parsing):** DOM elements parsed from the LMS. Malformed DOM could theoretically exploit vulnerabilities in the parsing logic (low likelihood).

## 6. Specific Threats & 7. Mitigations

| ID | Threat | Description | Mitigations |
| :--- | :--- | :--- | :--- |
| **T1** | Credential exposure via browser profile | Malware or unauthorized local access extracts session cookies or tokens from the persistent browser profile. | **M1:** Rely on OS-level file permissions. Store data in user-specific directories. Educate users on device security. |
| **T2** | Screenshot data leakage | Error screenshots contain sensitive LMS data (e.g., grades, private messages) and are accessed by unauthorized local processes or synced to insecure cloud storage. | **M2:** Implement automatic rotation/deletion of screenshots. Sanitize or blur known sensitive elements if feasible (difficult in practice). Rely on OS file permissions. |
| **T3** | Log injection / sensitive data in logs | Automation scripts accidentally log sensitive LMS data or user input. | **M3:** Strict log review. Never log DOM content, tokens, or personal info. Use parameterized logging. |
| **T4** | SQLite injection | Malicious metadata extracted from the LMS is improperly sanitized and used in SQL queries. | **M4:** Use parameterized queries or an ORM for all database interactions. Never concatenate strings for SQL. |
| **T5** | Dashboard XSS/CSRF | The Express dashboard fails to sanitize metadata before rendering, leading to XSS if the LMS serves malicious titles. CSRF if state-changing actions exist. | **M5:** Use a modern templating engine with auto-escaping (e.g., EJS, Pug) or a framework (React/Vue). Implement CSRF tokens if state-changing actions are added. |
| **T6** | Session hijacking via profile theft | An attacker copies the `browser-profile` folder to another machine to impersonate the user on the LMS. | **M6:** Warn users about the sensitivity of the data directory. Rely on OS security (encryption at rest, e.g., BitLocker/FileVault). |
| **T7** | Accidental write operations | Playwright scripts inadvertently click buttons or submit forms that alter state on the LMS (e.g., submitting assignments). | **M7:** Strict read-only Playwright locators. Avoid generic `.click()` on non-navigation elements. Extensive testing in a safe environment. |
| **T8** | Unintended network exposure | The Express server binds to `0.0.0.0` instead of `127.0.0.1`, exposing the dashboard to the local network. | **M8:** Hardcode the Express server to listen only on `127.0.0.1` (localhost). Verify in code review. |

## 8. Residual Risks

*   **Host Compromise:** If the user's machine is compromised by malware with user-level privileges, all local data (profile, DB, screenshots) is inherently vulnerable. LectureVault cannot protect against a compromised host OS.
*   **Physical Device Theft:** Without full-disk encryption, a stolen device leads to full compromise of the local session and data.
*   **LMS Platform Changes:** Unannounced changes to the LMS UI could break Playwright scripts, leading to missed data or unexpected behavior (though primarily an availability/reliability risk, not a direct security vulnerability).

## 9. Security Controls Checklist

- [ ] Express server binds explicitly and solely to `127.0.0.1`.
- [ ] SQLite queries exclusively use parameterized inputs.
- [ ] Dashboard templates automatically HTML-escape all variables.
- [ ] No hardcoded credentials or API keys exist in the codebase.
- [ ] Application does not prompt for or store LMS passwords.
- [ ] Playwright scripts contain no actions that modify LMS state (read-only interactions).
- [ ] Screenshot retention policy is implemented (e.g., delete after 7 days).
- [ ] Logging configuration is reviewed to prevent sensitive data leakage.
- [ ] User documentation explicitly states the location and sensitivity of the `data/` directory.

## 10. Data Classification Table

| Data Type | Classification | Storage Mechanism | Retention |
| :--- | :--- | :--- | :--- |
| **LMS Session Cookies/Tokens** | **Confidential** | Playwright persistent profile (disk) | Valid until session expires or manual logout. |
| **Error Screenshots** | **Confidential** | Local file system (`.png`) | Short-term (e.g., 7 days or manual deletion). |
| **LMS Metadata (Titles, URLs)**| **Internal** | SQLite Database | Indefinite / User managed. |
| **Application Logs** | **Internal** | Local file system (`.log`) | Rolling (e.g., 10MB max, keep last 3). |
| **App Configuration** | **Public** | `config.json` (or similar) | Indefinite. |
