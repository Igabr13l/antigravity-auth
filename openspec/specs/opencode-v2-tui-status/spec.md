# OpenCode 2 TUI Status Specification

## Purpose

OpenCode 2 loads the `./tui` export of every configured plugin inside its TUI
process and calls `setup(context)` with the TUI plugin context (slots, toasts,
dialogs, keymap, reactive storage). The adapter uses those surfaces to make the
shared account pool visible: a prompt-footer summary, sidebar account lines,
change toasts, and an accounts dialog that can enable/disable pool entries. The
TUI plugin never touches credentials or network calls; it reads and writes the
pool file only through the core storage layer.

## Requirements

### Requirement: TUI plugin loading without extra configuration

The package SHALL expose a real TUI plugin through its `./tui` export with id
`cortexkit.antigravity-auth.tui`, loaded automatically for any user who lists
the package in the `plugins` config; no separate TUI registration is required.
The TUI plugin SHALL NOT import the host SDK at runtime — only type imports —
because consumers do not install `@opencode-ai/plugin`.

#### Scenario: Host loads the TUI entry

- **WHEN** the OpenCode 2 TUI process imports the package's `./tui` export and
  calls `setup`
- **THEN** the plugin registers its slot claims and returns a teardown that
  disposes them

#### Scenario: Host compiles plugin JSX with its own runtime

- **WHEN** the compiled TUI entry's JSX runtime import (`@opentui/solid/jsx-runtime`)
  is resolved by the host loader
- **THEN** it is rewritten to the host's embedded OpenTUI runtime, so the
  package ships no Solid/OpenTUI runtime dependency (declared only as optional
  peers)

### Requirement: Pool status surfaces

The plugin SHALL claim the `prompt.footer.status` slot with a one-line pool
summary (`ready/total`, blocked and disabled counters) and the `sidebar.footer`
slot with one line per account showing its state (READY, COOLDOWN with
remaining minutes and family, INELIGIBLE, VALIDATION REQUIRED, DISABLED).
Accounts SHALL be identified by masked email (first local character plus
domain) or pool index — the redaction-sensitive `label` field MUST NOT be
rendered.

#### Scenario: Healthy pool

- **WHEN** the pool holds enabled accounts with no cooldowns or blocks
- **THEN** the footer summary reads `AGY <ready>/<total> ready` and each
  sidebar line shows READY

#### Scenario: Unreadable pool

- **WHEN** the pool file cannot be loaded
- **THEN** the summary reports the pool as unavailable instead of showing
  empty numbers, and the TUI is not disrupted

### Requirement: Pool change notifications

The plugin SHALL poll the pool file (default every 5 seconds) and, when an
account's state changes relative to the previous snapshot, SHALL show a toast:
warnings for ACCOUNT_INELIGIBLE and validation-required transitions, info for
cooldowns, disable, and re-enable transitions.

#### Scenario: Account becomes ineligible

- **WHEN** the server plugin persists `accountIneligible` for an account while
  the TUI is open
- **THEN** a warning toast names the masked account and the reason within one
  poll interval

### Requirement: Accounts dialog

The plugin SHALL register a keymap command (`antigravity.accounts`,
"Antigravity: accounts") with the default binding `ctrl+g` and palette
discovery, opening a select dialog listing every account with its formatted
status line. Selecting an account SHALL toggle its `enabled` flag through the
core lock-held pool mutation, show a confirmation toast, and refresh the
displayed status. (The beta command palette does not surface keymap-layer
commands yet; the default binding keeps the dialog reachable.)

#### Scenario: User opens the dialog and disables a misbehaving account

- **WHEN** the user presses `ctrl+g` and picks a ready account in the select
  dialog
- **THEN** the pool file records `enabled: false` for that account, a
  confirmation toast names the masked account, and the status surfaces refresh

#### Scenario: Dialog cancelled

- **WHEN** the user closes the select dialog without choosing
- **THEN** the pool stays untouched

### Requirement: TUI failures are non-fatal

Every host UI call (slot claims, toasts, keymap layer, dialog) SHALL be
defensive: a failure degrades that surface only (slot render falls back to
plain text, missing surfaces are skipped) and MUST NOT throw out of `setup`
or the render path.

#### Scenario: Host without a slot surface

- **WHEN** a host build rejects the slot claim or the renderer is absent
- **THEN** the plugin continues serving toasts and the pool remains unaffected
