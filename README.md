# pi-multi-auth

[![npm version](https://img.shields.io/npm/v/pi-multi-auth.svg)](https://www.npmjs.com/package/pi-multi-auth) [![GitHub](https://img.shields.io/badge/GitHub-MasuRii%2Fpi--multi--auth-blue)](https://github.com/MasuRii/pi-multi-auth)

<img width="1024" height="506" alt="image" src="https://github.com/user-attachments/assets/1aff63b4-0e1e-4eaa-93b4-5f4f9188224b" />

`pi-multi-auth` is a Pi extension for multi-provider credential management, OAuth login, and quota-aware account rotation.

- **npm**: https://www.npmjs.com/package/pi-multi-auth
- **GitHub**: https://github.com/MasuRii/pi-multi-auth

## Repository structure

This package now follows a conventional `src/` layout. The published entrypoint stays at the repository root as `index.ts`, runtime implementation lives under `src/`, and targeted compatibility shims remain at the package root for stable balancer subpaths.

```text
pi-multi-auth/
├── index.ts
├── balancer/
│   ├── index.ts
│   └── credential-backoff.ts
├── src/
│   ├── index.ts
│   ├── balancer/
│   ├── formatters/
│   ├── usage/
│   └── *.ts
├── tests/
├── package.json
├── tsconfig.json
├── tsconfig.test.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## Local usage

Place this folder in one of Pi's extension discovery paths:

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-multi-auth` |
| Project | `.pi/extensions/pi-multi-auth` |

Pi discovers the extension through the root `index.ts` entry listed in `package.json`, which forwards to `src/index.ts`.

## Configuration

Runtime configuration lives in `config.json` at the extension root. The extension creates the file automatically with defaults on first load if it does not already exist.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `debugLog` | `boolean` | `false` | Enables JSONL debug logging under `debug/pi-multi-auth-debug.jsonl` |
| `excludeProviders` | `string[]` | `[]` | Prevents selected providers from being wrapped by multi-auth |
| `cascade` | `object` | built-in defaults | Tunes retry backoff and retained failure history |
| `health` | `object` | built-in defaults | Tunes rolling health windows and scoring weights |
| `oauthRefresh` | `object` | built-in defaults | Controls proactive OAuth token refresh scheduling |

The published package intentionally excludes `config.json` and `debug/`; both are created locally as needed by the running extension.

## Validation

```bash
npm run build
npm run lint
npm run test
npm run check
```

## License

MIT