# Core Quota Manager Specification

## Purpose

`quota-manager.ts` is the harness-agnostic quota cache: it owns the per-account
cached quota result, in-flight de-duplication, and exponential backoff that
backgrounds proactive quota refreshes. Harnesses supply a `fetchAccountQuota`
callback returning the already-attributed `AccountQuotaResult`; the manager
injects status/error for disabled accounts and failed fetches, deduplicates by
stable account identity (never array index), and exposes pure aggregation
helpers (`aggregateQuota`, `aggregateQuotaSummary`, `aggregateGeminiCliQuota`)
plus network helpers (`fetchAvailableModels`, `fetchQuotaSummary`,
`fetchGeminiCliQuota`) shared by every adapter.

## Requirements

### Requirement: Stable identity and in-flight dedupe

The cache key SHALL come from `keyOf` — by default `e:<lowercased email>` or,
when email is absent, `t:<sha256(refreshToken)[:16]>` — never the array index,
so reorders/removals cannot corrupt cached state. Concurrent refreshes of the
same account SHALL share the single in-flight promise, preserving each
caller's requested `index` in the returned result. A fetch SHALL be bounded by
`fetchTimeoutMs` (default 10s) composed with the manager's dispose controller
via `AbortSignal.any`.

#### Scenario: Two concurrent quota refreshes

- **WHEN** two callers refresh the same account while the first is in flight
- **THEN** the harness callback runs once and both callers receive the cached
  result with their own `index`

### Requirement: Backoff with manual override

Failures (thrown fetch errors or `{ status: 'error' }` attribute results)
SHALL increment `consecutiveFailures` and set `backoffUntil = now + min(
maxBackoffMs, baseBackoffMs * 2^(failures-1))` (defaults: 30s base, 10min
cap). Success resets both to zero. While `backoffUntil > now` and `force` is
not set, a refresh SHALL skip the fetch and return the cached result (or an
`error` result naming the backoff deadline); `force: true` (manual quota
dialogs) bypasses backoff. A disposed manager SHALL return
`{ status: 'error', error: 'quota manager disposed' }`, and an
`enabled === false` account SHALL short-circuit to a `disabled` result
without fetching.

#### Scenario: Repeated 5xx from the quota endpoint

- **WHEN** a refresh fails and another is requested immediately
- **THEN** the second returns the cached/skipped result without calling the
  harness callback until the backoff deadline passes

### Requirement: Disposal fences in-flight work

`dispose()` SHALL abort every in-flight controller, await all pending
refresh promises via `Promise.allSettled` (each resolves rather than
rejecting), and clear `inflight` on every entry, so no refresh can enqueue a
post-dispose side effect. Subsequent refreshes SHALL fail with the disposed
error.

#### Scenario: Dispose mid-fetch

- **WHEN** `dispose()` runs while a refresh is in flight
- **THEN** the refresh resolves with an abort error and the returned promise
  settles only after it has

### Requirement: Group classification and aggregation

`classifyQuotaGroup` SHALL consult the model registry first, then classify
`claude`/`gpt-oss` substrings as `non-gemini` BEFORE `gemini` (so a
`gemini-claude-*` alias lands in the non-gemini pool), then `gemini`, else
`null`. `aggregateQuota` SHALL keep, per group, the minimum
`remainingFraction` and earliest `resetTime` across models, a sorted
per-model list (fraction clamped 0–1, missing treated as 0), and the model
count. `aggregateQuotaSummary` SHALL map bucket id prefixes `gemini-`→gemini
and `3p-`→non-gemini (first RECOGNIZED bucket wins), sort a pool's windows
shortest-first (`5h` before `weekly`), derive the pool's remaining fraction
and reset from the most-constrained window, and count models from the
group description after stripping a `Label:` prefix.

#### Scenario: Pool derived from most-constrained window

- **WHEN** a gemini group reports 5h at 60% and weekly at 20%
- **THEN** the gemini summary shows 20% with the weekly reset time, windows
  ordered 5h first

### Requirement: Quota fetch failover conventions

`fetchAvailableModels` SHALL iterate endpoints, retrying a 403 against the
same endpoint once without the `project` body, continuing on 429/5xx/network
errors and breaking on other non-OK statuses. `fetchQuotaSummary` SHALL POST
`/v1internal:retrieveUserQuotaSummary` per endpoint; on 403 it MAY retry the
regular `projectId` only when the managed-project attempt 403'd — a transient
failure (429/5xx/network) MUST NOT fall through to a different project. On
exhaustion it SHALL throw the collected errors; a non-retryable (e.g. 403)
`fetchGeminiCliQuota` response SHALL yield `{ buckets: [] }` while transport
errors across all endpoints SHALL throw. All fetches SHALL run with the
request timeout via `fetchWithActiveTimeout` (or an injected `fetchVia`
seam) and the Antigravity harness user agent.

#### Scenario: Managed project 403s, regular project succeeds

- **WHEN** the managed project returns 403 and the regular project returns
  200 at the next endpoint
- **THEN** the summary comes from the regular project

#### Scenario: Managed project hits a 429

- **WHEN** the managed project endpoint answers 429
- **THEN** the code continues to the next endpoint with the same managed
  project and never queries the regular project id
