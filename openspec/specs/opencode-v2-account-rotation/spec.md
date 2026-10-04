# OpenCode 2 Account Rotation Specification

## Purpose

Antigravity quota is per Google account, so the bridge rotates over the shared
multi-account pool in `antigravity-accounts.json` (v4 schema, lock-held
read-modify-write shared with the OpenCode 1 adapter and the CLI). Selection,
refresh, endpoint fallback, and quota marking reuse the core account manager;
failures exclude the account and move the pool forward instead of failing the
user's turn whenever another account can serve.

## Requirements

### Requirement: Account selection with exclusion

For each request the bridge SHALL select the enabled account best positioned
by the hybrid strategy for the model family (claude/gemini) and requested
model, using the session id as selection identity, and SHALL exclude accounts
that failed earlier in the same request. The loop bounds attempts at pool size
plus two.

#### Scenario: First account rate-limited

- **WHEN** the selected account answers 429 and the pool holds another enabled
  account
- **THEN** the marked account is excluded and the request retries on the next
  candidate

### Requirement: Token access and forced refresh

The bridge SHALL serve requests from cached access tokens while they remain
valid with a 60-second safety margin, refreshing through the shared OAuth
refresh flow otherwise. On a 401 upstream response it SHALL force exactly one
token refresh per account and retry the endpoint once before excluding the
account.

#### Scenario: Expired access token

- **WHEN** the cached access token is within 60 seconds of expiry
- **THEN** the bridge refreshes it before building the request and persists the
  new expiry through the account manager

#### Scenario: Upstream rejects the access token

- **WHEN** Antigravity answers 401 for a freshly cached token
- **THEN** the bridge forces a refresh and retries the same endpoint a single
  time

### Requirement: Endpoint fallback chain

The bridge SHALL attempt the ordered Antigravity endpoint fallback list,
continuing to the next endpoint on transport errors, 404, and 503/529
capacity responses until the chain is exhausted.

#### Scenario: Primary endpoint is at capacity

- **WHEN** the first endpoint answers 503
- **THEN** the bridge retries the remaining endpoints with the same envelope
  before marking the account

### Requirement: Quota and capacity marking

The bridge SHALL mark accounts rate-limited with the parsed reason and
`retry-after`-derived backoff (bounded 1 minute–1 hour) on 429, and mark model
capacity exhaustion (45 seconds–1 hour) on final 503/529 capacity failure,
persisting cooldown state to disk.

#### Scenario: 429 with retry-after

- **WHEN** the upstream answers 429 with a `retry-after` header
- **THEN** the account's cooldown for that family/model uses the provided
  delay and the state is saved

### Requirement: Ineligibility and validation persistence

The bridge SHALL persist `enabled: false` with the failure reason when
Antigravity answers 403 `ACCOUNT_INELIGIBLE` or `VALIDATION_REQUIRED` for an
account, excluding it from selection until re-enabled (a successful OAuth
login re-enables the account).

#### Scenario: Account flagged ACCOUNT_INELIGIBLE

- **WHEN** the upstream answers 403 with reason `ACCOUNT_INELIGIBLE`
- **THEN** the pool file records the account as ineligible with a timestamp
  and the request continues on another account

### Requirement: Exhaustion surfaces as failure

When every candidate account fails, the bridge SHALL throw the last error,
which the loopback maps to a `502` JSON response for the host; the error text
MUST state that no Antigravity account is available when the pool is
exhausted.

#### Scenario: Pool fully exhausted

- **WHEN** all enabled accounts are rate-limited or excluded for the request
- **THEN** the host receives a 502 whose message identifies account
  exhaustion
