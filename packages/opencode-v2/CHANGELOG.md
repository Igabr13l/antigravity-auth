# Changelog

## [Unreleased]

### Added

- Added a native OpenCode 2 TUI plugin (`./tui` entry): prompt-footer pool summary, sidebar footer per-account status, toast notifications for pool changes (ineligibility, validation, cooldowns, enable/disable), and an accounts dialog bound to `ctrl+g` to inspect and toggle accounts. Verified against host beta-19271: footer summary renders reactively, the dialog lists masked accounts, and selection persists through the lock-held pool mutation. Accounts are displayed by masked email only; Solid/OpenTUI runtimes are resolved from the host's embedded copies (optional peers).
- Changed the `oc-plugin` manifest to `["server", "tui"]`.
- Added OpenSpec capability specs under `openspec/specs/` covering packaging, request bridging, envelope invariants, account rotation, OAuth, TUI status, and e2e verification.
- Added a drift-guard test asserting `example/opencode.json` declares exactly the models the bridge routes.

### Changed

- Re-verified the adapter against OpenCode 2 host beta-19271 (`@opencode-ai/plugin` and `@opencode-ai/cli` test pins bumped from beta-19234); the promise-plugin contract (`http.request` hook, integration OAuth method, `Host.resolve` packaging) is unchanged between the two betas, and the TUI entry is loaded and set up by the beta-19271 TUI process.
- Fixed Google-blocked accounts (`ACCOUNT_INELIGIBLE`, validation required) rendering as plain `DISABLED`. core disables an account as it applies the block, so testing `enabled` first hid the block from the blocked counter and downgraded its toast to a non-warning. Blocks now outrank the enabled flag.
- Fixed the accounts dialog re-enabling a blocked account. It wrote `enabled: true` next to `accountIneligible`, which core's load path honours, returning an unusable account to rotation. The dialog now warns and leaves the pool untouched, matching `AccountManager.setAccountEnabled()` and the OpenCode 1 adapter.
- Fixed pool change detection keying on the pool index. Adding or removing an account renumbers the rest, which reported unchanged accounts as `re-enabled` and attributed one account's prior state to another. Accounts are now matched by an opaque, address-derived key that also survives a bare refresh-token rotation.
- Fixed the accounts dialog toggling by a stale index. The target is now resolved by key inside the lock-held write; if it is gone, the plugin warns instead of editing whichever account took its position. The dialog also re-checks a Google block on the fresh record inside the lock, refuses positional (index-derived) identities, and refuses when two accounts normalise to the same address key.
- Fixed account-wide cooldowns (`coolingDownUntil`) displaying as `READY`. core excludes such an account from dispatch, so the TUI contradicted the router. The cooldown reason is now shown alongside per-family rate limits.
- Fixed the accounts command being registered only from the `prompt.footer.status` slot, leaving `ctrl+g` unreachable when that slot failed to claim. Both slots now retry the bind.
- Fixed overlapping poll and post-mutation refreshes. Refreshes are now strictly serialised, so a slow read can never race a newer one, and a failed read no longer wipes the diff baseline — the next successful read reports the transitions that occurred while the pool was unreadable. The plugin also no longer publishes UI state from a read that is still in flight when the plugin is disposed.

## [2.3.0] - 2026-09-17

### Added

- Added the OpenCode 2.x host adapter with shared Antigravity OAuth, model routing, account rotation, and raw AGY transport.
- Added deterministic real-host coverage in a network-isolated Docker container.
- Enforced AGY request metadata, tool-call signatures, Claude thinking, image handling, and terminal stream error propagation.
