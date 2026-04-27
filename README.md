# pi-multi-auth

[![npm version](https://img.shields.io/npm/v/pi-multi-auth?style=flat-square)](https://www.npmjs.com/package/pi-multi-auth) [![License](https://img.shields.io/github/license/MasuRii/pi-multi-auth?style=flat-square)](LICENSE)

<img width="1024" height="506" alt="image" src="https://github.com/user-attachments/assets/1aff63b4-0e1e-4eaa-93b4-5f4f9188224b" />

`pi-multi-auth` is a Pi extension for multi-provider credential management, OAuth login, and quota-aware account rotation.

- **npm**: https://www.npmjs.com/package/pi-multi-auth
- **GitHub**: https://github.com/MasuRii/pi-multi-auth

## Capabilities

- Wraps discovered Pi providers with multi-account rotation, quota-aware cooldowns, failover, health scoring, and optional pool selection.
- Supports OAuth credential management for providers exposed by Pi and registers first-class Cline OAuth login and refresh handling.
- Applies per-credential request overrides for provider base URLs and headers, with Cloudflare Workers AI credentials using account-scoped OpenAI-compatible base URLs.
- Enriches status-only provider failures with bounded diagnostic probes so authentication, permission, billing, and rate-limit errors include actionable provider response details when available.
- Provides lightweight rotation for API-key providers that do not expose external usage state, including delegated parent-session lease reuse.
- Persists extension state and usage snapshots under Pi's runtime directory while keeping local `config.json` and debug output outside the published package.
- Coordinates fresh usage refreshes across selection, startup, modal, and manual refresh flows with bounded concurrency, candidate windows, cooldowns, and circuit breaking.

## Repository structure

This package follows a conventional `src/` layout. The published entrypoint stays at the repository root as `index.ts`, runtime implementation lives under `src/`, and package exports map stable balancer subpaths to `src/balancer/*`.

```text
pi-multi-auth/
├── index.ts
├── src/
│   ├── index.ts
│   ├── balancer/
│   ├── formatters/
│   ├── usage/
│   └── *.ts
├── tests/
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.test.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## Installation

### npm package

```bash
pi install npm:pi-multi-auth
```

### Local extension folder

Place this folder in one of Pi's extension discovery paths:

| Scope | Path |
|-------|------|
| Global default | `~/.pi/agent/extensions/pi-multi-auth` (respects `PI_CODING_AGENT_DIR`) |
| Project | `.pi/extensions/pi-multi-auth` |

Pi discovers the extension through the root `index.ts` entry listed in `package.json`, which forwards to `src/index.ts`.

The global path above is the default when `PI_CODING_AGENT_DIR` is unset; otherwise Pi resolves the global extension path under `$PI_CODING_AGENT_DIR/extensions/pi-multi-auth`.

## Configuration

Runtime configuration lives in `config.json` at the extension root. The extension creates the file automatically with defaults on first load if it does not already exist.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `debug` | `boolean` | `false` | Enables JSONL debug logging under `debug/pi-multi-auth-debug.jsonl` |
| `excludeProviders` | `string[]` | `[]` | Prevents selected providers from being wrapped by multi-auth |
| `cascade` | `object` | built-in defaults | Tunes retry backoff and retained failure history |
| `health` | `object` | built-in defaults | Tunes rolling health windows and scoring weights |
| `historyPersistence` | `object` | built-in defaults | Controls extracted health and cascade history file names under `debug/` |
| `modelEntitlements` | `object` | built-in defaults | Controls provider-specific model entitlement behavior such as Codex usage lookup failures |
| `oauthRefresh` | `object` | built-in defaults | Controls proactive OAuth token refresh scheduling, concurrency, and excluded providers |
| `usageCoordination` | `object` | built-in defaults | Bounds fresh usage lookups with global/per-provider concurrency, operation-specific candidate windows, account/provider cooldowns, and circuit breakers |

The published package intentionally excludes `config.json` and `debug/`; both are created locally as needed by the running extension. Usage snapshots are cached in Pi's runtime directory as `multi-auth-usage-cache.json` so operational and display-only usage state can survive extension restarts without publishing local state.

### Credential request overrides

Credentials may include a `request` object with provider-specific request settings:

| Key | Type | Purpose |
|-----|------|---------|
| `request.baseUrl` | `string` | Overrides the model base URL for that credential after URL validation |
| `request.headers` | `Record<string, string>` | Adds credential-scoped headers to the provider request |

Cloudflare Workers AI credentials must use `https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1` as the OpenAI-compatible base URL. When adding a Cloudflare API-key credential, the extension discovers this URL automatically if the token can list exactly one account; otherwise add `request.baseUrl` manually for the intended account.

## Validation

```bash
npm run build
npm run lint
npm run test
npm run check
```

## Related Pi Extensions

- [pi-permission-system](https://github.com/MasuRii/pi-permission-system) — Permission enforcement for tool and command access
- [pi-tool-display](https://github.com/MasuRii/pi-tool-display) — Compact tool rendering and diff visualization
- [pi-MUST-have-extension](https://github.com/MasuRii/pi-MUST-have-extension) — RFC 2119 keyword normalization for prompts
- [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) — RTK command rewriting and output compaction

## License

MIT