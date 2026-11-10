# Core Plan Tier and Model Catalog Specification

## Purpose

Google Antigravity accounts have distinct subscription tiers (`free`, `plus`,
`pro`, `ultra`) captured from the upstream `loadCodeAssist` metadata. The plugin
normalizes these raw tier IDs, distinguishes user plans in status surfaces, and
routes model requests according to account tier capabilities. In addition, the
model registry exposes full thinking variants (`minimal`, `low`, `medium`,
`high`) for Gemini models and supports dynamic catalog discovery from
`fetchAvailableModels`.

## Requirements

### Requirement: Plan tier normalization and precedence

The core plan-tier module SHALL normalize raw tier identifiers into the
canonical union `'free' | 'plus' | 'pro' | 'ultra' | 'unknown'`.
When determining an account's plan, a non-empty `capturedPaidTierId` SHALL take
precedence over `capturedTierId` (which frequently defaults to `free-tier` in
upstream responses even for subscribed accounts). Raw tier strings containing
`ultra` SHALL resolve to `ultra`; strings containing `pro`, `standard`,
`enterprise`, or `premium` SHALL resolve to `pro`; strings containing `plus`
SHALL resolve to `plus`; strings containing `free`, `basic`, or `starter` SHALL
resolve to `free`. Any unrecognized or missing tier strings SHALL resolve to
`unknown`.

#### Scenario: Subscribed user with default currentTier

- **WHEN** an account has `capturedTierId: "free-tier"` and `capturedPaidTierId: "pro-tier"`
- **THEN** `resolveAccountPlanTier(account)` evaluates to `"pro"`

#### Scenario: Free user without paidTier

- **WHEN** an account has `capturedTierId: "free-tier"` and `capturedPaidTierId: undefined`
- **THEN** `resolveAccountPlanTier(account)` evaluates to `"free"`

#### Scenario: Ultra subscriber

- **WHEN** an account has `capturedPaidTierId: "g1-ultra"` or `capturedTierId: "gemini-ultra-tier"`
- **THEN** `resolveAccountPlanTier(account)` evaluates to `"ultra"`

### Requirement: Plan tier ranking and comparison

The core plan-tier module SHALL provide `isPlanAtLeast(current, required)` based
on the strict hierarchy `unknown (0) < free (1) < plus (2) < pro (3) < ultra (4)`.
A requirement of `unknown` or `free` SHALL evaluate to `true` for any current
tier.

#### Scenario: Pro account meets Plus requirement

- **WHEN** checking `isPlanAtLeast("pro", "plus")`
- **THEN** the result is `true`

#### Scenario: Free account fails Pro requirement

- **WHEN** checking `isPlanAtLeast("free", "pro")`
- **THEN** the result is `false`

### Requirement: Plan-aware account selection

`AccountManager.getCurrentOrNextForFamily` SHALL consider model tier
requirements when selecting an account. When a requested `model` has a known
minimum plan requirement (e.g. `minPlan: "pro"` for Claude Opus or
`minPlan: "plus"` for Sonnet/GPT-OSS), the selection pipeline SHALL filter or
prefer candidate accounts whose resolved plan tier satisfies the requirement.
If no enabled accounts satisfy the requirement, selection SHALL fall back
gracefully to available accounts rather than hard-failing.

#### Scenario: Opus request with mixed free and pro accounts

- **WHEN** an account pool contains account 0 (`free`) and account 1 (`pro`)
- **AND** a request arrives for `antigravity-claude-opus-4-6-thinking`
- **THEN** account 1 (`pro`) is selected

### Requirement: Full model variants exposure

Gemini Flash models in the model registry (`antigravity-gemini-3.8-flash`,
`antigravity-gemini-3.7-flash`, `antigravity-gemini-3.6-flash`,
`antigravity-gemini-3.5-flash`) SHALL expose four thinking variants in their
definitions: `minimal`, `low`, `medium`, and `high`.
Gemini 4 Argon (`antigravity-gemini-4-argon`), Gemini 4 Carbon (`antigravity-gemini-4-carbon`),
Claude Opus 5.5 (`antigravity-claude-opus-5-5-thinking`), Claude Sonnet 5.5 (`antigravity-claude-sonnet-5-5-thinking`),
and Gemini 3.1 Pro SHALL expose `low`, `medium`, and `high` variants.
The model resolver SHALL support `-minimal`, `-low`, `-medium`, and `-high`
tier suffixes across all Gemini 3/4 and Claude 5.5 thinking models.

#### Scenario: Flash 3.8 variants inspection

- **WHEN** inspecting `OPENCODE_MODEL_DEFINITIONS['antigravity-gemini-3.8-flash'].variants`
- **THEN** `minimal`, `low`, `medium`, and `high` variants are all defined with
  matching `thinkingLevel` values

#### Scenario: Resolving Gemini 3.8 Flash minimal

- **WHEN** resolving model `gemini-3.8-flash-minimal`
- **THEN** the resolved tier is `minimal` and actualModel maps to `gemini-3.8-flash-low`

### Requirement: Dynamic model discovery and catalog extension

The core module SHALL provide `discoverModelsFromApiResponse` to convert
upstream `fetchAvailableModels` responses into valid `OpencodeModelDefinition`
objects. Dynamic models SHALL be registered via `registerDynamicModels` and
surfaced in `getPublicModelDefinitions()` alongside static base definitions.
Dynamic registration SHALL NOT corrupt or overwrite existing static definitions
unless explicitly updating their metadata.

#### Scenario: Upstream model discovery

- **WHEN** `fetchAvailableModels` returns a response containing a new model `gemini-3.9-flash`
- **THEN** `discoverModelsFromApiResponse` constructs a definition with context 1M, output 64k,
  flash thinking variants, and `minPlan: "free"`
- **AND** registering it makes it available in `getPublicModelDefinitions()`

### Requirement: User plan distinction in UI and CLI

OpenCode 2 `AccountStatus` in `pool-status.ts` SHALL include `planTier: PlanTier`.
OpenCode 1 `CommandAccountRow` in `command-data.ts` SHALL include `planTier: PlanTier`
and `formattedPlanTier: string`.
CLI `antigravity-auth list` SHALL display the resolved plan tier for each account.
