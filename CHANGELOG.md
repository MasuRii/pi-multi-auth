# Changelog

All notable changes to this project will be documented in this file.

## 0.3.0 - 2026-04-25

### Added
- Added first-class Cline OAuth registration, browser callback handling, token exchange, token refresh, WorkOS request secret formatting, and Cline client request headers.
- Added Cline credential identity deduplication and Cline-specific token expiration handling for proactive refresh scheduling.
- Added delegated runtime credential override handling and explicit lightweight parent-session lease release support.

### Changed
- Updated package compatibility metadata to Pi 0.70.x packages.
- Preserved still-active Cline OAuth tokens when refresh failures are permanent but the current access token remains usable.
- Hardened startup, shutdown, abort, and credential lookup paths with shared structured error helpers.

### Fixed
- Skipped expired JWT-backed API key credentials during Cline selection and surfaced clear re-authentication errors for expired manual selections.
- Ensured Cline OAuth request secrets are formatted consistently without requiring runtime OAuth registry state.
- Prevented stale lightweight leases from surviving cooldown and parent-session release flows.

## 0.2.0 - 2026-04-22

### Added
- Added lightweight rotation support for non-OAuth providers, including provider-agnostic rotation classification, staged state flushing, and parent-session lease reuse in the key distributor.
- Added configurable Codex entitlement handling for usage lookup failures together with extracted health and cascade history persistence for provider state.

### Changed
- Updated startup and session lifecycle handling so warmup begins on `session_start`, reloads refresh extension config, and delegated runtimes resolve state paths through Pi's agent runtime directory.
- Updated package compatibility metadata to Pi 0.68.1 and documented the `PI_CODING_AGENT_DIR`-aware global install path.

### Fixed
- Preserved caller-initiated abort semantics during rotated requests while keeping retries limited to extension-owned timeout cases.
- Improved OAuth refresh failure summaries and quota cooldown persistence, including rate-limit-derived exhaustion windows and provider metadata refresh after `models.json` changes.

## 0.1.2 - 2026-04-01

### Changed
- Enhanced package discoverability with aligned npm keywords for better searchability.
- Added npm and GitHub repository links in `package.json` and `README.md` for package discoverability.
- Added Related Pi Extensions cross-linking section in README for ecosystem navigation.

## 0.1.1 - 2026-04-01

### Fixed
- Preserve `StreamAttemptTimeoutError` identity when abort signals propagate through generic `AbortError` surfaces. Timeout-triggered aborts now correctly surface the original timeout error context instead of wrapping it in generic abort messages.
- Properly distinguish caller-initiated aborts from timeout-triggered aborts to ensure caller aborts remain terminal without retry looping.

## 0.1.0 - 2026-03-31

### Changed
- Added public-repository packaging metadata and published file selection for the extension package.
- Added repository artifacts for open-source distribution: `README.md`, `CHANGELOG.md`, `LICENSE`, `.npmignore`, and TypeScript project configs.
- Kept the runtime entrypoint and existing source import layout unchanged to preserve extension behavior.
