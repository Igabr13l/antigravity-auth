# Changelog

## [Unreleased]

### Fixed

- Fixed the TUI plugin registering a new keymap layer on every slot render, which stalled the host's keymap dispatcher — `ctrl+c` (and other bound keys) stopped responding, most visibly in resumed sessions. Host 2.0.22's `ctx.keymap.commands()` never lists keymap-layer commands, so the "re-register when dropped" probe always considered the layer gone; with reactive footer content re-rendering the slots at high frequency (~80/s observed), layers accumulated unboundedly. The accounts layer is now bound exactly once per TUI session (failed first attempts still retry on later renders); `ctrl+g` verified to still open the accounts dialog against the real host.
- Fixed a hung request when the Antigravity connection resets mid-body (core transport): `pipe` forwards neither socket errors nor a destroyed source to the piped decode chain, so a connection reset between chunks left the response stream open forever and the consumer's read pending — the idle watchdog destroyed the socket but could not wake it. Socket teardown now fails the decoded stream with an explicit error, so the bridge answers 502 instead of hanging. Proven with a regression test on a raw socket pair.
- Fixed every Antigravity tool-bearing request failing with `Antigravity HTTP 400 (INVALID_ARGUMENT)`: Gemini's Schema proto has no `exclusiveMinimum`/`exclusiveMaximum` fields, so Antigravity's strict protobuf validation rejected the payload ("Unknown name ... Cannot find field"). core's `toGeminiSchema` now moves exclusive numeric bounds to a description hint on every target, not only when the GPT numeric-constraint move is enabled.

### Added

- Added a native OpenCode 2 TUI plugin (`./tui` entry): prompt-footer pool summary, sidebar footer per-account status, toast notifications for pool changes (ineligibility, validation, cooldowns, enable/disable), and an accounts dialog bound to `ctrl+g` to inspect and toggle accounts. Verified against host beta-19271: footer summary renders reactively, the dialog lists masked accounts, and selection persists through the lock-held pool mutation. Accounts are displayed by masked email only; Solid/OpenTUI runtimes are resolved from the host's embedded copies (optional peers).
- Changed the `oc-plugin` manifest to `["server", "tui"]`.
- Added OpenSpec capability specs under `openspec/specs/` covering packaging, request bridging, envelope invariants, account rotation, OAuth, TUI status, and e2e verification.
- Added `install:local` (and `scripts/install-local.ts`) to install the working-tree build as a discovered OpenCode 2 plugin under `<config>/plugins/antigravity-auth/`, so a local checkout needs no npm publish and no `opencode.json`/`cli.json` entry.
- Added a drift-guard test asserting `example/opencode.json` declares exactly the models the bridge routes.

### Changed

- Re-verified the adapter against OpenCode 2 host beta-19271 (`@opencode-ai/plugin` and `@opencode-ai/cli` test pins bumped from beta-19234); the promise-plugin contract (`http.request` hook, integration OAuth method, `Host.resolve` packaging) is unchanged between the two betas, and the TUI entry is loaded and set up by the beta-19271 TUI process.
- Fixed Google-blocked accounts (`ACCOUNT_INELIGIBLE`, validation required) rendering as plain `DISABLED`. core disables an account as it applies the block, so testing `enabled` first hid the block from the blocked counter and downgraded its toast to a non-warning. Blocks now outrank the enabled flag.
- Fixed the accounts dialog re-enabling a blocked account. It wrote `enabled: true` next to `accountIneligible`, which core's load path honours, returning an unusable account to rotation. The dialog now warns and leaves the pool untouched, matching `AccountManager.setAccountEnabled()` and the OpenCode 1 adapter.
- Fixed pool change detection keying on the pool index. Adding or removing an account renumbers the rest, which reported unchanged accounts as `re-enabled` and attributed one account's prior state to another. Accounts are now matched by an opaque, address-derived key that also survives a bare refresh-token rotation.
- Fixed the accounts dialog toggling by a stale index. The target is now resolved by key inside the lock-held write; if it is gone, the plugin warns instead of editing whichever account took its position. The dialog also re-checks a Google block on the fresh record inside the lock, refuses positional (index-derived) identities, and refuses when two accounts normalise to the same address key.
- Fixed a stale dialog decision being applied by inversion. The toggle now sets `enabled` to the value the displayed state implies, so an account another actor disabled mid-dialog is not silently re-enabled. A refused toggle aborts the mutation callback before the pool file is written, so rejected actions no longer rewrite the file or trigger external watchers.
- Fixed change detection emitting transitions it cannot attribute: keys derived from pool position, and keys shared by two normalised addresses, are now skipped instead of being matched against the wrong account.
- Fixed a retry of the Antigravity login failing with `Failed to start server. Is port 51121 in use?`. The fixed redirect port is now released before a new attempt binds it (the previous listener's promise rejects as superseded), matching the OpenCode 1 adapter; if an unrelated process holds the port, the listener reports the conflict instead of a bare bind error.
- Fixed account-wide cooldowns (`coolingDownUntil`) displaying as `READY`. core excludes such an account from dispatch, so the TUI contradicted the router. The cooldown reason is now shown alongside per-family rate limits.
- Fixed overlapping poll and post-mutation refreshes. Refreshes are serialised and coalesce into a single queued read, so a slow read can never race a newer one and poll ticks cannot grow the queue without bound. A failed read no longer wipes the diff baseline, so the next successful read reports the transitions that occurred while the pool was unreadable. No further reads start, and no state is published, once the plugin is disposed.
- Fixed the accounts command being registered only from the `prompt.footer.status` slot, leaving `ctrl+g` unreachable when that slot failed to claim. Both slots retry the bind, and the command is re-registered if the host drops its layer when the owning component unmounts.

## [2.3.0] - 2026-09-17

### Added

- Added the OpenCode 2.x host adapter with shared Antigravity OAuth, model routing, account rotation, and raw AGY transport.
- Added deterministic real-host coverage in a network-isolated Docker container.
- Enforced AGY request metadata, tool-call signatures, Claude thinking, image handling, and terminal stream error propagation.
