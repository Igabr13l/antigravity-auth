# AGENTS.md

Guidance for AI agents working with this repository.

## Overview

Google Antigravity OAuth adapters for OpenCode 1, OpenCode 2, and Pi. OpenCode 1 intercepts host fetches; OpenCode 2 rewrites provider requests to an adapter-owned loopback bridge; Pi registers a custom provider. Shared auth, transport, storage, quota, and rotation logic lives in core.

## Build & Test Commands

```bash
bun install                          # Install dependencies
bun run build                        # Compile (tsc -p tsconfig.build.json)
bun run typecheck                    # Type-check only (tsc --noEmit)
bun run test                         # Run all unit tests (bun test --isolate across packages)
bun test --isolate src/plugin/auth.test.ts            # Single test file
bun test --isolate -t "test name here"                # Single test by name (uses bun:test's -t filter)
bun test --isolate --watch src/plugin/auth.test.ts   # Watch mode, single file
bun run test:e2e                     # Deterministic OpenCode 1/Pi e2e flows
bun run test:e2e:opencode-v2         # Default/CI: real host in Docker with network disabled
bun run test:e2e:opencode-v2:local   # Explicit local debug run; isolated OPENCODE_DB is mandatory
bun run test:e2e:models              # Live Antigravity model inventory (CI-gated, network)
bun run test:e2e:regression          # Cross-model + Gemini CLI regression (network)
bun run --cwd packages/opencode smoke:tui            # Pack-and-install smoke test for the TUI subpath
bun run smoke:opencode-v2            # Pack/install OpenCode 2 and resolve through Host.resolve()
```

Format and lint via Biome:

```bash
bun run format                       # biome format --write .
bun run format:check                 # biome format .  (CI gate)
bun run lint                         # biome lint .     (CI gate)
```

Pre-commit hooks (`.lefthook.yml`) run Biome on changed `*.{ts,tsx,js,mjs,json,jsonc,yml,yaml}` files via `bunx biome check --staged --no-errors-on-unmatched`. The repo pins the toolchain in `mise.toml` (`bun = "1.3"`, `node = "24"`) and CI uses `oven-sh/setup-bun@v2` with `bun-version: 1.3`.

## TypeScript Configuration

- `strict: true` with extra strictness: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `target: ESNext`, `module: Preserve`, `moduleResolution: bundler`
- `allowImportingTsExtensions: true` — use `.ts` extensions in imports
- No path aliases — all imports are relative

## Code Style

### Imports
- Use `import type { ... }` for type-only imports (enforced by `verbatimModuleSyntax`)
- Named imports only — no default imports in src/
- Relative paths with `.ts` extensions: `import { foo } from "./bar.ts"`
- Order: node builtins > external packages > local modules

### Exports
- Named exports only in src/, except host contracts that require a default export (Pi and OpenCode 2 server entries)
- Barrel files (index.ts) for module surfaces

### Naming
- `camelCase` for functions, variables, parameters
- `PascalCase` for types, interfaces, classes, enums
- `UPPER_SNAKE_CASE` for constants
- `kebab-case` for file names (e.g., `request-helpers.ts`, `thinking-recovery.ts`)
- Test files: `*.test.ts` colocated with source

### Types
- No `I` prefix on interfaces, no `Type` suffix
- Use `z.infer<typeof Schema>` for Zod-derived types
- Extract to `types.ts` when shared, inline when local
- Discriminated unions preferred over boolean flags
- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`

### Functions
- `export function` for public APIs
- Arrow functions for callbacks, factories, and inline closures
- Async functions with targeted try/catch (not blanket)

### Error Handling
- Defensive try/catch with graceful degradation (fallback values, not crashes)
- Custom error classes with metadata when domain-specific
- Catch `unknown`, log, and convert to domain errors — never empty catch blocks
- Rate limit / quota errors trigger account rotation, not failure

### Formatting
- 2-space indentation
- Single quotes for strings (Biome `quoteStyle: single`)
- Trailing commas in multiline constructs
- No semicolons (project convention)

### Logging
- `createLogger("module-name")` for structured logging
- `console.log` only for CLI/user-facing output

## Module Structure

The repository is a Bun workspace with four published packages. The harness-agnostic engine and the OpenCode 1, OpenCode 2, and Pi adapters ship independently.

```
packages/
├── core/                    # Harness-agnostic engine — auth, transform, storage, fingerprinting
│   └── src/
│       ├── index.ts             # Public barrel
│       ├── account-manager.ts   # Per-account selection, rate-limit, quota, fingerprint
│       ├── account-storage.ts   # v4 schema + lock-held read-modify-write + fail-closed unreadable
│       ├── agy-transport.ts     # Bounded TLS pool, gzip/chunk decode, idle watchdog
│       ├── agy-request-metadata.ts
│       ├── antigravity/oauth.ts # OAuth token exchange + refresh
│       ├── auth.ts              # Token validation helpers
│       ├── file-lock.ts         # Fenced file lock for concurrent writes
│       ├── fingerprint.ts       # Device fingerprint construction
│       ├── model-registry.ts    # Anthropic / Gemini / GPT-OSS model definitions
│       ├── project.ts           # Managed project resolution
│       ├── quota-manager.ts     # Quota caching + fallbacks
│       ├── rotation.ts          # Account rotation state
│       └── transform/           # Claude / Gemini / cross-model sanitizer + tests
├── opencode/                # OpenCode 1 host adapter — plugin entry, fetch interceptor, TUI
│   └── src/
│       ├── cli.ts               # `antigravity-auth` CLI (login / list / quota)
│       ├── plugin/              # Plugin factory, OAuth methods, account access, fetch
│       │   ├── fetch-interceptor.ts  # Outer/inner loop, retry/quota/routing pipeline
│       │   ├── auth-loader.ts   # Host `auth.loader()` integration
│       │   ├── oauth-methods.ts # OAuth menu + callbacks
│       │   ├── persist-account-pool.ts # Lock-held append after fresh OAuth login
│       │   ├── storage.ts       # Host-path adapter for account pool (re-exports core errors)
│       │   └── ui/              # TUI sidebar, auth menu, quota-status, command dialogs
│       ├── tui/                 # Precompiled + raw TUI sources
│       ├── rpc/                 # Loopback RPC server + client (sidebar notifications)
│       └── hooks/               # Lifecycle hooks (auto-update checker, etc.)
├── opencode-v2/             # OpenCode 2 Promise-plugin adapter
│   ├── src/plugin.ts            # Request hook + loopback bridge + OAuth integration
│   ├── src/tui.tsx              # TUI plugin — pool status slots, toasts, accounts dialog
│   ├── src/pool-status.ts       # Pure pool → display-status derivation (masked email only)
│   ├── src/paths.ts             # Shared pool-file path resolution
│   ├── test/                    # Contract and final-wire tests
│   └── scripts/                 # Packed-consumer Host.resolve smoke test
└── pi/                      # Pi host adapter — thinner facade around core
    └── src/
        ├── index.ts             # Public barrel — `streamCortexKitAntigravity` + OAuth helpers
        ├── convert.ts           # Pi <-> Antigravity message-shape conversion
        ├── credential-cache.ts # Packed refresh token cache
        ├── paths.ts             # Pi AGENT_DIR + account-pool path resolution
        └── stream.ts            # Stream factory consumed by `index.ts`
```

## Key Design Patterns

### 1. Request Interception
OpenCode 1 intercepts `fetch()` for `generativelanguage.googleapis.com`. OpenCode 2 cannot return a custom response from `session.hook('http.request')`, so it rewrites matching requests to an ephemeral `127.0.0.1` bridge and lets the host dispatch normally. The bridge then calls the shared AGY transport. Never run an OpenCode 2 test or probe unless `OPENCODE_DB` points to an isolated temporary database.

### 2. Claude Thinking Blocks
ALL thinking blocks are stripped from outgoing requests for Claude models. Claude generates fresh thinking each turn. This eliminates signature validation errors.

### 3. Session Recovery
When tool execution is interrupted (ESC/timeout), the plugin injects synthetic `tool_result` blocks to recover the session without starting over.

### 4. Schema Sanitization
Tool schemas are cleaned via allowlist. Unsupported fields (`const`, `$ref`, `$defs`) are removed or converted to Antigravity-compatible format.

### 5. Multi-Account Load Balancing
Accounts rotate on rate limits. Gemini has dual quota pools (Antigravity headers + Gemini CLI headers). Fingerprints are per-account and regenerated on capacity exhaustion.

### 6. Fingerprint System
Per-account device fingerprints stored in `antigravity-accounts.json`. Each fingerprint includes deviceId, sessionToken, userAgent, and a reduced clientMetadata (ideType, platform, pluginType — no osVersion, arch, or sqmId). The only header composed is `User-Agent`, built by `buildFingerprintHeaders()` in `fingerprint.ts` and applied on the antigravity request path in `request.ts`. History tracked (max 5), restorable.

## Dependencies

- `zod ^4` — schema validation (NOT zod v3)
- `@opencode-ai/plugin` — OpenCode plugin interface
- `@openauthjs/openauth` — OAuth client
- `proper-lockfile` — file locking for concurrent access
- `xdg-basedir` — XDG directory resolution

## Testing

- Framework: **Bun's test runner** (`bun test`; the `bun:test` module re-exports a jest-compatible namespace)
- Config: no per-package config — Bun discovers `*.test.ts` next to source. The `bunfig.toml` at the root and in each workspace preloads `test/setup.ts` (env-isolation + a per-test mkdtemp root + a `globalThis.stubbed` / `unstubAllGlobals` / `freshImport` helper). The e2e workspace uses `bunfig.toml` `root = "./src"` so its tests stay isolated from the unit workspace.
- Tests colocated: `src/plugin/foo.test.ts` next to `src/plugin/foo.ts`. The e2e workspace uses `*.e2e.test.ts` so the root `bun run test` and `bun run test:e2e` selectors can target them precisely.
- Use `describe`/`it`/`expect` from `bun:test` — the standard API.
- Mock with `mock()`, `spyOn()`, and the `jest` namespace exported from `bun:test` (`jest.fn`, `jest.spyOn`, `jest.setSystemTime`, etc.). The `test/setup.ts` preload patches `jest.setSystemTime` / `jest.useRealTimers` so they also spy on `Date.now()` (Bun's `bun:test` clock only fakes the timer queue, not the wall clock).

## Documentation

- [README.md](README.md) — Installation & usage
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Detailed architecture guide
- [docs/ANTIGRAVITY_API_SPEC.md](docs/ANTIGRAVITY_API_SPEC.md) — API reference
- [CHANGELOG.md](CHANGELOG.md) — Version history
- [ARCHITECTURE.md](ARCHITECTURE.md) and [STRUCTURE.md](STRUCTURE.md) — repo-level architecture and file-system map
- `openspec/` — OpenSpec capability specs (validate with `openspec validate --specs --strict`); behavior changes to the adapters must update the matching spec
- [biome.json](biome.json) — formatter + linter config
- [lefthook.yml](lefthook.yml) — pre-commit Biome hook
- [mise.toml](mise.toml) — pinned `bun` + `node` versions

OpenCode 2 is the `0.0.0-beta-*` line of `@opencode-ai/plugin` / `@opencode-ai/cli` (promise-plugin API: `session.hook('http.request')`, `integration.transform`); OpenCode 1 is the `1.x` line. The v2 adapter pins both to the same beta and the e2e suite runs the real host binary.
