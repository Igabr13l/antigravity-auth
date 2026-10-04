# OpenCode 2 E2E Verification Specification

## Purpose

The adapter's guarantees (routing, envelope invariants, rotation, streaming)
are pinned by deterministic end-to-end tests that run the REAL OpenCode 2 host
binary against a mock Antigravity server. Because the host owns real session
state, every OpenCode 2 test or probe MUST isolate `OPENCODE_DB` to a
temporary database.

## Requirements

### Requirement: Real-host, network-isolated coverage

The default CI e2e (`bun run test:e2e:opencode-v2`) SHALL run the pinned real
host binary from `@opencode-ai/cli` inside Docker with networking disabled
(`--network none`), with the adapter's upstream pointed at an in-container
mock Antigravity server, so tests never touch Google endpoints. A local
variant SHALL exist for debugging and MUST enforce an isolated `OPENCODE_DB`.

#### Scenario: CI run without network access

- **WHEN** the Docker e2e image runs with `--network none`
- **THEN** the host starts, loads the adapter, and completes every flow
  against the loopback mock only

#### Scenario: Local debug run

- **WHEN** `test:e2e:opencode-v2:local` executes on the host machine
- **THEN** it runs only with an isolated temporary `OPENCODE_DB`

### Requirement: Wire invariants asserted end to end

The e2e suite SHALL assert, through the mock server, that the host dispatches
zero direct provider requests (all traffic flows through the bridge) and that
outgoing envelopes preserve the contract: model enum resolution, `VALIDATED`
tool config, trailing user turn, metadata labels and session ids, signed
tool-call roundtrips with `thoughtSignature` preserved, and the Claude
thinking contract (thinkingBudget 1024, maxOutputTokens 64 000).

#### Scenario: Signed tool-call roundtrip

- **WHEN** the model returns a tool call with a `thoughtSignature` and the
  session continues with the tool result
- **THEN** the follow-up envelope replays the signature on the same-model
  continuation and the tool-call sequence completes without signature errors

#### Scenario: Provider isolation

- **WHEN** the host runs a session against an Antigravity model
- **THEN** no request reaches the provider's real endpoint directly from the
  host

### Requirement: Failure paths pinned by tests

The e2e suite SHALL pin the failure semantics: ineligible accounts are
persisted and rotation proceeds to the next account, daily→prod endpoint
fallback engages on capacity exhaustion, terminal transport failures and
embedded SSE errors surface as host-visible errors, and clean EOF without a
terminal frame fails without replay.

#### Scenario: Ineligible first account

- **WHEN** the mock marks the first account `ACCOUNT_INELIGIBLE`
- **THEN** the pool file persists `enabled: false` with the reason and the
  session continues on the second account

#### Scenario: Capacity exhaustion triggers fallback

- **WHEN** the primary endpoint answers with capacity exhaustion for the
  account
- **THEN** the bridge retries the next fallback endpoint before marking the
  account

### Requirement: Packed-consumer smoke

The smoke script (`smoke:opencode-v2`) SHALL pack core and the adapter,
install them into an isolated consumer, and resolve the plugin through the
real host resolver (`Host.resolve`), asserting the server entry stays inside
the installed package and the compatibility TUI/RPC entries load.

#### Scenario: Smoke run

- **WHEN** `bun run smoke:opencode-v2` completes
- **THEN** the packed package resolves through `Host.resolve` with a valid
  server entry and inert TUI/RPC placeholders
