# Core Account Storage (v4) Specification

## Purpose

Core owns the on-disk account pool shared by every harness (OpenCode 1,
OpenCode 2, Pi, CLI). The pool is a v4 JSON document: an array of account
records keyed by refresh token, per-family active indexes, and eligibility
flags. Every read and write goes through a fenced file lock, a strict
read-modify-write cycle, fail-closed handling of unreadable files, and
atomic writes — so a corrupt, partially-written, or concurrently-written
pool can never silently destroy user data.

## Requirements

### Requirement: v4 schema and legacy migration

The storage layer SHALL treat `version: 4` as the canonical shape —
`{ version: 4, accounts: AccountMetadataV3[], activeIndex: number,
activeIndexByFamily }` — and SHALL in-place migrate v1, v2, and v3 files
through `migrateV1ToV2 → migrateV2ToV3 → migrateV3ToV4`. Migrations map
legacy `rateLimitResetTime` fields onto family keys (`claude`,
`gemini-antigravity`) and drop `fingerprint`/`fingerprintHistory` on the
v3→v4 step. A migrated pool SHALL be persisted back as v4; a failed
persist SHALL be logged but not fatal.

#### Scenario: Legacy v3 file is loaded

- **WHEN** `loadAccountStorage` reads a file with `version: 3`
- **THEN** the in-memory result is a normalized v4 pool and the on-disk
  file is rewritten at `version: 4`

### Requirement: Strict record validation and normalization

Every v4 account record SHALL be a non-null object with a non-empty string
`refreshToken` and finite numeric `addedAt` and `lastUsed`; violations SHALL
surface as `invalid-shape` unreadable, never silent filtering. Accounts
sharing an email SHALL be deduplicated, keeping the newest by `lastUsed`
then `addedAt`. `activeIndex` SHALL be clamped into `[0, accounts.length-1]`
and reset to 0 for an empty pool.

#### Scenario: Duplicate emails in the pool

- **WHEN** two records share an email with different `lastUsed`
- **THEN** the load keeps only the record with the larger `lastUsed`

### Requirement: Lock-held read-modify-write

`mutateAccountStorage` SHALL hold a fenced file lock (`ttlMs: 10_000`,
renewal enabled) for the entire read-modify-write: read + normalize, run
the caller's mutator (sync or async), assert ownership, then atomically
write the result. Lock acquisition SHALL retry contention on the fixed
schedule `100, 200, 400, 800, 1000` ms before throwing the typed
`AccountStorageLockContentionError`; real I/O errors SHALL be rethrown
immediately rather than retried. A mutator returning `undefined` SHALL
keep the current state but still persist it.

#### Scenario: Two processes write concurrently

- **WHEN** one process holds the lock and another calls
  `mutateAccountStorage`
- **THEN** the second retries on the 100–1000ms schedule and only throws
  `AccountStorageLockContentionError` after the initial attempt plus five
  retries

### Requirement: Fail-closed on unreadable files

When the accounts file exists but cannot be parsed as a usable pool —
`malformed-json`, `invalid-shape`, `unsupported-version` (a version newer
than 4), or `io-error` (ENOENT excluded) — both `loadAccountStorage` and
`mutateAccountStorage` SHALL throw `AccountStorageUnreadableError` with
the reason, detail, and backup path. The layer SHALL NOT treat the file
as an empty pool, and the mutator SHALL NOT write. A best-effort
`.corrupt-<ISO-timestamp>` sidecar copy SHALL be attempted before
throwing; the copy itself must never throw.

#### Scenario: Pool file contains truncated JSON

- **WHEN** the file is not valid JSON
- **THEN** the caller receives `AccountStorageUnreadableError` with
  reason `malformed-json`, a `.corrupt-*` backup exists, and the original
  file is untouched

#### Scenario: File written by a newer version

- **WHEN** the file declares `version: 5`
- **THEN** the layer fails closed with reason `unsupported-version`
  instead of overwriting the newer data on the next write

#### Scenario: First run

- **WHEN** the file does not exist (ENOENT)
- **THEN** `loadAccountStorage` returns `null` and
  `mutateAccountStorage` seeds `{ version: 4, accounts: [], activeIndex: 0 }`

### Requirement: Atomic, permission-hardened writes

Writes SHALL go through `writeJsonAtomic` (no partial files on crash) and
the pool and any corrupt backup SHALL be chmod `0o600` (best-effort).
`saveAccountStorage` SHALL merge by refresh token;
`saveAccountStorageReplace` SHALL overwrite unconditionally for destructive
operations; `clearAccountStorage` SHALL hold the lock while unlinking and
treat ENOENT as a successful no-op.

#### Scenario: Delete account

- **WHEN** the CLI removes an account via `saveAccountStorageReplace`
- **THEN** the on-disk pool is exactly the replacement, not a merge with
  the previous contents

### Requirement: Merge preserves eligibility and freshness

Merging two v4 pools SHALL key accounts by `refreshToken`, preserve
`projectId`/`managedProjectId` when the incoming side omits them, take
`Math.max` on `lastUsed`, and pick the eligibility fields from whichever
side has the newer `eligibilityStateUpdatedAt`. A merged account with
`accountIneligible` SHALL be forced to `enabled: false`.

#### Scenario: Stale writer regresses ineligibility

- **WHEN** an incoming pool carries an older
  `eligibilityStateUpdatedAt` than the persisted ineligible record
- **THEN** the merged account keeps the persisted ineligible decision and
  stays disabled
