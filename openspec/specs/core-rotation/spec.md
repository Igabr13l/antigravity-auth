# Core Rotation Specification

## Purpose

`rotation.ts` holds the pure account-rotation primitives shared by every
harness: rate-limit reason parsing and backoff calculation, health-score
tracking, token-bucket throttling, LRU and hybrid account selection, and
jitter utilities. It has no I/O — callers feed it observed outcomes and
metrics and it decides cooldowns and which account to prefer next.

## Requirements

### Requirement: Rate-limit reason classification

`parseRateLimitReason` SHALL map status 529/503 to
`MODEL_CAPACITY_EXHAUSTED` and 500 to `SERVER_ERROR` before inspecting the
reason string; a reason matching `QUOTA_EXHAUSTED`/`RATE_LIMIT_EXCEEDED`/
`MODEL_CAPACITY_EXHAUSTED` (case-insensitive) wins. Otherwise the message
SHALL be scanned for `capacity`/`overloaded`/`resource exhausted` →
capacity, `per minute`/`rate limit`/`too many requests`/`presque` → rate
limit, and `exhausted`/`quota` → `QUOTA_EXHAUSTED`, defaulting to
`UNKNOWN`.

#### Scenario: 529 from the upstream

- **WHEN** the response status is 529 regardless of body
- **THEN** the reason is `MODEL_CAPACITY_EXHAUSTED`

### Requirement: Backoff schedule

`calculateBackoffMs` SHALL prefer a positive `retryAfterMs` clamped to a
2s floor. Otherwise: `QUOTA_EXHAUSTED` climbs the tiered schedule
`60s, 300s, 1800s, 7200s` indexed by `min(consecutiveFailures, 3)`;
`RATE_LIMIT_EXCEEDED` is flat 30s; `MODEL_CAPACITY_EXHAUSTED` is 45s
adjusted by ±15s of jitter (`jitter * 30s` offset by half the range);
`SERVER_ERROR` is 20s; `UNKNOWN` is 60s.

#### Scenario: Repeated quota exhaustion

- **WHEN** the same account exhausts quota three times in a row and no
  retry-after is provided
- **THEN** the third cooldown is 1800s

### Requirement: Health scores

`HealthScoreTracker` SHALL start accounts at 70, add 1 per success (capped
at 100), subtract 10 per rate limit and 20 per failure (floored at 0), and
passively recover 2 points per hour of rest applied at read time. An
account is usable when its recovered score is at least 50; consecutive
failure counts reset on success; unknown accounts read at the initial score.

#### Scenario: Account rests overnight

- **WHEN** an account with score 40 has not been updated for 10 hours
- **THEN** its score is 60 and it is usable again

### Requirement: Token bucket throttling

`TokenBucketTracker` SHALL give each account an initial bucket of 50,
regenerate 6 tokens/minute up to a cap of 50, and require `cost` (default
1) before `consume` succeeds; `refund` adds back up to the cap.
`hasTokens(index, cost)` SHALL report balance against the supplied cost.

#### Scenario: Bucket drains

- **WHEN** an account consumes its 50 tokens and tries again immediately
- **THEN** `consume` returns false and the account is unavailable for
  hybrid selection until regeneration crosses the cost

### Requirement: Selection strategies

`sortByLruWithHealth` SHALL drop rate-limited, cooling-down, and
unhealthy (`healthScore < minHealthScore`, default 50) accounts, then order
by ascending `lastUsed` with higher health score breaking ties.
`selectHybridAccount` SHALL additionally require available tokens, score
candidates as `healthScore*2 + (tokens/maxTokens)*100*5 +
min(secondsSinceUsed, 3600)*0.1`, add a 150-point stickiness bonus to the
current account, and only switch when the challenger's BASE score beats the
current account's base score by at least 100 (`SWITCH_THRESHOLD`). With no
eligible candidates it SHALL return `null`.

#### Scenario: Challenger barely ahead

- **WHEN** another account's base score exceeds the current account's by
  80
- **THEN** the current account keeps the session

### Requirement: Jitter and delay utilities

`addJitter` SHALL vary the base delay by ±`jitterFactor` (default 0.3) and
never return below 0; `randomDelay` SHALL return a value in
`[minMs, maxMs]`; `computeSoftQuotaCacheTtlMs` SHALL resolve `'auto'` to
`max(2 * refreshIntervalMinutes, 10)` minutes and pass explicit numbers
through as minutes.

#### Scenario: Auto soft-quota TTL

- **WHEN** the refresh interval is 3 minutes and the TTL config is `'auto'`
- **THEN** the cache TTL is 10 minutes (600,000 ms)
