# Changelog

All notable changes to this project will be documented in this file.

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
