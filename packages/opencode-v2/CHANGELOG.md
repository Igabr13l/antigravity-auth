# Changelog

## [Unreleased]

### Added

- Added a native OpenCode 2 TUI plugin (`./tui` entry): prompt-footer pool summary, sidebar footer per-account status, toast notifications for pool changes (ineligibility, validation, cooldowns, enable/disable), and an accounts dialog bound to `ctrl+g` to inspect and toggle accounts. Verified against host beta-19271: footer summary renders reactively, the dialog lists masked accounts, and selection persists through the lock-held pool mutation. Accounts are displayed by masked email only; Solid/OpenTUI runtimes are resolved from the host's embedded copies (optional peers).
- Changed the `oc-plugin` manifest to `["server", "tui"]`.
- Added OpenSpec capability specs under `openspec/specs/` covering packaging, request bridging, envelope invariants, account rotation, OAuth, TUI status, and e2e verification.
- Added a drift-guard test asserting `example/opencode.json` declares exactly the models the bridge routes.

### Changed

- Re-verified the adapter against OpenCode 2 host beta-19271 (`@opencode-ai/plugin` and `@opencode-ai/cli` test pins bumped from beta-19234); the promise-plugin contract (`http.request` hook, integration OAuth method, `Host.resolve` packaging) is unchanged between the two betas, and the TUI entry is loaded and set up by the beta-19271 TUI process.

## [2.3.0] - 2026-09-17

### Added

- Added the OpenCode 2.x host adapter with shared Antigravity OAuth, model routing, account rotation, and raw AGY transport.
- Added deterministic real-host coverage in a network-isolated Docker container.
- Enforced AGY request metadata, tool-call signatures, Claude thinking, image handling, and terminal stream error propagation.
