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
continuing to the next endpoint on transport errors and 404, and continuing on
503/529 capacity responses except skipping fallback to Gemini CLI production
(`cloudcode-pa.googleapis.com`) when routing Antigravity-only models (`claude*`,
`gpt-oss*`, `gemini-4-*`, `image*`, `tab_*`).

#### Scenario: Primary endpoint is at capacity

- **WHEN** the first endpoint answers 503 for a model supported on fallback
  endpoints (such as `gemini-3.8-flash`)
- **THEN** the bridge retries the remaining endpoints with the same envelope
  before marking the account

#### Scenario: Primary endpoint is at capacity for an Antigravity-only model

- **WHEN** the daily Antigravity endpoint answers 503 for an Antigravity-only
  model (such as Claude Opus or Gemini 4 Argon)
- **THEN** the bridge skips `cloudcode-pa.googleapis.com` fallback, marks model
  capacity exhaustion immediately, and rotates to the next account

### Requirement: Quota and capacity marking

The bridge SHALL mark accounts rate-limited with the parsed reason and
`retry-after`-derived backoff (bounded 1 minute–1 hour) on 429, and mark model
capacity exhaustion (45 seconds–1 hour) whenever an owning Antigravity endpoint
(`endpointOwnsAccountQuota === true`, e.g. `daily`) hits 503/529 capacity failure
even if subsequent non-owning fallback endpoints fail with 429/503/404/transport
errors, persisting cooldown state to disk via `requestSaveToDisk`.

#### Scenario: Daily 503 capacity followed by failing prod fallback

- **WHEN** the daily endpoint returns 503 capacity exhaustion and the subsequent
  `cloudcode-pa.googleapis.com` fallback fails
- **THEN** the account is marked `MODEL_CAPACITY_EXHAUSTED` and persisted to disk

#### Scenario: 429 with retry-after

- **WHEN** the upstream answers 429 with a `retry-after` header
- **THEN** the account's cooldown for that family/model uses the provided
  delay and the state is saved

#### Scenario: 429 with Google RPC RetryInfo or ErrorInfo metadata

- **WHEN** the upstream answers 429 without a `retry-after` header but carries
  `RetryInfo.retryDelay` or `ErrorInfo.metadata.quotaResetDelay`/`quotaResetTimeStamp` in the response body
- **THEN** the account's cooldown uses the extracted RPC delay instead of the
  fallback value and the state is saved

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
