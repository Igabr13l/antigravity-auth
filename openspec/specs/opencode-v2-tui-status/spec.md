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

### Requirement: Stable account identity

Each derived account SHALL carry an opaque key that identifies it independently
of its position in the pool, so that the same account can be matched across
polls and across pool mutations. The key SHALL NOT reveal the raw address.

#### Scenario: Account shifts position in the pool

- **WHEN** an account is removed and the accounts after it shift down
- **THEN** each account's key is unchanged

#### Scenario: Account with no address

- **WHEN** a pool entry carries no address
- **THEN** its key falls back to one derived from its pool index

### Requirement: Google blocks outrank the enabled flag

When deriving an account's displayed state, the plugin SHALL evaluate a Google
access block ahead of the `enabled` flag, because core disables an account as
it applies such a block and `enabled: false` is then a symptom of the block
rather than an operator decision. A blocked account SHALL count toward the
blocked total and SHALL NOT be reported as merely disabled.

#### Scenario: Google blocks an account core had enabled

- **WHEN** core persists `enabled: false` together with `accountIneligible`
- **THEN** the account renders INELIGIBLE, counts as blocked rather than
  disabled, and the transition raises a warning toast

#### Scenario: Block is lifted from a disabled account

- **WHEN** an account carries `enabled: false` and its block flags clear
- **THEN** the account renders DISABLED, not re-enabled

### Requirement: Account-wide cooldowns are surfaced

The plugin SHALL derive cooldown state from the account-wide cooldown
(`coolingDownUntil` with its `cooldownReason`) in addition to the per-family
rate-limit resets, because core excludes such an account from dispatch and
reporting it as READY would contradict the router.

#### Scenario: Account-wide cooldown without a rate-limit entry

- **WHEN** an enabled account carries a future `coolingDownUntil` and no
  per-family reset
- **THEN** the account renders as COOLDOWN naming the cooldown reason, and
  never as READY

#### Scenario: Several cooldowns overlap

- **WHEN** a per-family reset and an account-wide cooldown are both in the
  future
- **THEN** both are named, and the reported cooldown end is the later of the two

#### Scenario: Cooldown already elapsed

- **WHEN** a per-family reset time or `coolingDownUntil` is in the past
- **THEN** the account renders as READY

### Requirement: Pool change notifications

The plugin SHALL poll the pool file (default every 5 seconds) and, when an
account's state changes relative to the previous snapshot, SHALL show a toast:
warnings for ACCOUNT_INELIGIBLE and validation-required transitions, info for
cooldowns, disable, and re-enable transitions.

#### Scenario: An account is added to the pool

- **WHEN** an account with no counterpart in the previous snapshot appears
- **THEN** no transition is reported, because it has no prior state

#### Scenario: Account becomes ineligible

- **WHEN** the server plugin persists `accountIneligible` for an account while
  the TUI is open
- **THEN** a warning toast names the masked account and the reason within one
  poll interval

#### Scenario: An account is removed from the pool

- **WHEN** one account leaves the pool and the accounts after it shift down a
  position
- **THEN** no transition is reported for the accounts that merely shifted

#### Scenario: Pool becomes unreadable and recovers

- **WHEN** a read fails and a later read succeeds with a changed account
- **THEN** the recovered read reports the change as a transition

### Requirement: Change detection matches by key

Change detection SHALL match accounts by their stable key rather than by pool
index, so that inserting or removing an account does not renumber the remainder
into false transitions. A transition SHALL only be reported when the key
identifies exactly one account on each side: keys derived from pool position,
and keys shared by more than one account, SHALL be skipped rather than
attributed to the wrong account.

#### Scenario: An account is removed from the pool

- **WHEN** one account leaves the pool and the accounts after it shift down a
  position
- **THEN** no transition is reported for the accounts that merely shifted

#### Scenario: An address-less account inherits a position

- **WHEN** an account with no address takes the index another account vacated
- **THEN** no transition is reported for it, because its position is not an
  identity

#### Scenario: Two accounts share a normalised address

- **WHEN** two accounts normalise to the same key and only one changes state
- **THEN** no transition is reported, because neither can be attributed

### Requirement: Reads are serialized and re-baselined

Concurrent poll and post-mutation refreshes SHALL be serialized so that a caller
never receives a snapshot older than its own request. Refreshes that arrive
while a read is in flight SHALL coalesce into a single queued read rather than
accumulating one per call. When a read fails, the plugin SHALL drop the rendered
snapshot but keep the last good baseline, so the next successful read reports
the changes that occurred in the gap. No further read SHALL start once the
plugin has been disposed.

#### Scenario: Pool becomes unreadable and recovers

- **WHEN** a read fails and a later read succeeds with a changed account
- **THEN** the recovered read reports the change as a transition

#### Scenario: A mutation races the poll

- **WHEN** a poll read is still in flight as a mutation completes
- **THEN** the post-mutation refresh waits for it and republishes, so the
  displayed state is never older than the write

#### Scenario: Polls arrive during a slow read

- **WHEN** several poll intervals elapse while one read is stalled
- **THEN** they coalesce into a single queued read instead of one read per
  interval

#### Scenario: The plugin is disposed mid-read

- **WHEN** the cleanup runs while a read is pending
- **THEN** the pending read does not start another and does not publish state

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

#### Scenario: User picks a Google-blocked account

- **WHEN** the user picks an account that is ineligible or awaiting validation
- **THEN** a warning toast explains that the account is blocked, the pool file
  is left untouched, and the account's `enabled` flag is not flipped to true

### Requirement: The dialog resolves its target by key

The dialog SHALL select and mutate by stable key, re-resolving the target inside
the lock-held write, because a concurrent login or removal may have renumbered
the pool since the dialog was built.

#### Scenario: Pool shifts while the dialog is open

- **WHEN** an account is removed between the dialog opening and the write
- **THEN** the toggle applies to the originally selected account, resolved by
  key, and not to whichever account took its position

#### Scenario: Selected account is gone by the time of the write

- **WHEN** the target no longer exists in the pool being written
- **THEN** the plugin warns and leaves the pool untouched, rather than applying
  the toggle to whichever account now occupies that position

#### Scenario: Several pool entries share an address

- **WHEN** two accounts normalise to the same address key
- **THEN** the plugin warns and leaves the pool untouched, rather than toggling
  all of them at once

### Requirement: The dialog applies the displayed decision

The dialog SHALL set the account's `enabled` flag to the value the displayed
state implies (enabled when the row showed DISABLED, disabled otherwise), not
invert whatever value the fresh record happens to hold. A concurrent change
between display and write SHALL NOT be reversed.

#### Scenario: Another actor disables the account mid-dialog

- **WHEN** the row showed READY and the account is disabled before the write
- **THEN** the write leaves it disabled, rather than re-enabling it

### Requirement: A refused toggle does not rewrite the pool

When the dialog refuses a toggle (missing target, ambiguous identity, or a
block that landed), the mutation SHALL abort before the pool file is written,
so no watcher sees a spurious modification and no migration is triggered.

#### Scenario: Toggle refused inside the lock

- **WHEN** the mutation callback rejects the toggle
- **THEN** the pool file is not rewritten

### Requirement: The dialog will not re-enable a blocked account

The dialog SHALL NOT re-enable an account carrying a Google access block. core
refuses to enable such an account and honours a persisted `enabled: true` on
load, so flipping the flag would place an unusable account back into rotation.
The block SHALL be re-checked on the record inside the lock-held write, because
it may have been set while the dialog was open.

#### Scenario: User picks a Google-blocked account

- **WHEN** the user picks an account that is ineligible or awaiting validation
- **THEN** a warning toast explains that the account is blocked, the pool file
  is left untouched, and the account's `enabled` flag is not flipped to true

#### Scenario: Google blocks the account while the dialog is open

- **WHEN** the record picked in the dialog carries a block flag on the write
- **THEN** the write leaves the pool untouched and warns instead of toggling

### Requirement: The dialog will not toggle an ambiguous identity

The dialog SHALL refuse to toggle when the account's identity cannot be sure
enough to write safely: an index-derived key (no address on file) or two
accounts that normalise to the same key.

#### Scenario: Account has no address on file

- **WHEN** the selected account derives its key from its pool position
- **THEN** the plugin warns and does not mutate, instead of trusting a
  positional identity

### Requirement: Command registration does not depend on one slot

The keymap layer SHALL be registered from whichever slot the host mounts, so
that a failure to claim one surface does not leave the accounts command
unreachable. Because the host owns a layer by the component that registered it,
the plugin SHALL re-register the command when a later render finds it no longer
reachable.

#### Scenario: Prompt-footer slot unavailable

- **WHEN** the host rejects the `prompt.footer.status` claim but mounts
  `sidebar.footer`
- **THEN** rendering the sidebar registers the keymap layer and the accounts
  command remains reachable

#### Scenario: The owning component unmounts

- **WHEN** a render finds the accounts command no longer reachable, because the
  layer's component was torn down
- **THEN** the plugin registers the layer again instead of trusting its
  already-bound flag

### Requirement: TUI failures are non-fatal

Every host UI call (slot claims, toasts, keymap layer, dialog) SHALL be
defensive: a failure degrades that surface only (slot render falls back to
plain text, missing surfaces are skipped) and MUST NOT throw out of `setup`
or the render path.

#### Scenario: Host without a slot surface

- **WHEN** a host build rejects the slot claim or the renderer is absent
- **THEN** the plugin continues serving toasts and the pool remains unaffected
