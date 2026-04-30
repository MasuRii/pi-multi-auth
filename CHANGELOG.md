# Changelog

All notable changes to this project will be documented in this file.

## 0.6.0 - 2026-04-30

### Added
- Added a guided provider configuration dialog for API-key and OAuth setup that separates configured and available providers, supports search, and preserves credential-count context.
- Added API-key provider discovery from Pi built-ins, `models.json`, and known `auth.json` credentials so supported providers can be selected before credentials exist.
- Added delegated credential pinning for parent-session credential reuse with explicit unavailable and model-entitlement diagnostics.

### Changed
- Refined the account manager modal to show visible account counts, alias/account columns, and color-highlighted plan details.
- Updated Cloudflare Workers AI daily allocation classification to infer UTC reset windows and reconcile persisted cooldown state from saved quota errors.
- Updated Pi development dependencies and lockfile entries to `0.70.6` for release preparation.

## 0.5.0 - 2026-04-28

### Changed
- Updated OpenAI Codex account selection to prefer fresh or durable cached usage evidence before scheduling bounded background refreshes, reducing selection latency while preserving quota-aware routing.
- Refined usage coordination with rotating candidate windows, preferred credential cache keys, and cache disambiguation for reused Codex credential ids.
- Updated Codex paid-entitlement checks to use durable negative usage evidence without forcing a fresh bootstrap when cached plan data is authoritative.
- Added explicit Codex usage request timeouts, including IPv4 fallback timeout handling, so stalled usage probes fail with clear diagnostic errors.
- Updated package metadata and lockfile version to `0.5.0` for release preparation.

## 0.4.0 - 2026-04-27

### Added
- Added per-credential request overrides for provider base URLs and headers, including Cloudflare Workers AI account-scoped base URL validation and account discovery for Cloudflare API-key credentials.
- Added provider response diagnostics for status-only OpenAI-compatible failures so authentication, permission, billing, and rate-limit errors can surface provider status codes, codes, messages, and operator actions.
- Added persistent usage snapshot caching under Pi's runtime directory with display-only last-known entries for warm starts and degraded usage visibility.
- Added coordinated usage refresh admission control with global and per-provider concurrency limits, operation-specific candidate windows, account/provider cooldowns, and circuit breakers.

### Changed
- Updated usage selection, blocked-account reconciliation, startup refinement, modal refresh, and manual refresh flows to share the persistent cache and usage coordinator instead of issuing unbounded fresh usage requests.
- Centralized local development runners so lint emits a stable empty JSON result on success and compiled tests are discovered from `.test-dist/tests` automatically.
- Updated package metadata and lockfile version to `0.4.0` for release preparation.

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
