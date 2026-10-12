# Core Claude Model Routing Specification

## Purpose

Google Antigravity serves Claude thinking requests through dedicated wire
models. Standard accounts do not have access to Claude 5.5 wire models (which
return 404 NOT_FOUND on Antigravity upstream), but have active access to native
Claude 4.6 models. The core registry and resolver expose and route only Claude
4.6 models (`claude-opus-4-6-thinking` and `claude-sonnet-4-6`), mapping legacy
and variant-suffixed identifiers directly to their native wire models with a
fixed 1024-token thinking budget.

## Requirements

### Requirement: Claude 4.6 model catalog exposure

The model registry SHALL expose exactly two public Claude thinking models:
`antigravity-claude-opus-4-6-thinking` and
`antigravity-claude-sonnet-4-6-thinking`. Both models SHALL specify
`reasoning: true`, a 250 000 context limit, a 64 000 output token limit, and
disabled automatic `low`/`high` variants (`variants: { low: { disabled: true },
high: { disabled: true } }`). Claude 5.5 model identifiers SHALL NOT be present
in `OPENCODE_MODEL_DEFINITIONS`.

#### Scenario: Inspecting public model definitions

- **WHEN** a client calls `getPublicModelDefinitions()`
- **THEN** both `antigravity-claude-opus-4-6-thinking` and
  `antigravity-claude-sonnet-4-6-thinking` are present
- **AND** `antigravity-claude-opus-5-5-thinking` and
  `antigravity-claude-sonnet-5-5-thinking` are absent

### Requirement: Claude 4.6 wire model resolution

The model resolver SHALL resolve Claude 4.6 requests to their native untiered
wire model IDs: `claude-opus-4-6-thinking` for Opus and `claude-sonnet-4-6` for
Sonnet. Requests for both models SHALL be assigned `isThinkingModel: true` and a
fixed `thinkingBudget: 1024` without a `thinkingLevel`.

#### Scenario: Resolving Sonnet 4.6 thinking request

- **WHEN** a request arrives for `claude-sonnet-4-6-thinking`
- **THEN** the resolver returns `actualModel: "claude-sonnet-4-6"`
- **AND** `thinkingBudget` is 1024

#### Scenario: Resolving Opus 4.6 thinking request

- **WHEN** a request arrives for `claude-opus-4-6-thinking`
- **THEN** the resolver returns `actualModel: "claude-opus-4-6-thinking"`
- **AND** `thinkingBudget` is 1024

### Requirement: Suffix and alias normalization

The model resolver and alias registry SHALL normalize legacy, variant-suffixed,
and namespace-prefixed Claude identifiers directly to their canonical 4.6 wire
models. Identifiers with suffixes `-low`, `-medium`, `-high`, or `-max`, as
well as `gemini-claude-*` aliases, SHALL map to `claude-opus-4-6-thinking` or
`claude-sonnet-4-6` respectively.

#### Scenario: Resolving suffixed Opus alias

- **WHEN** a request specifies `claude-opus-4-6-thinking-max` or
  `gemini-claude-opus-4-6-thinking-high`
- **THEN** the resolved model is `claude-opus-4-6-thinking`

#### Scenario: Resolving suffixed Sonnet alias

- **WHEN** a request specifies `claude-sonnet-4-6-thinking-low` or
  `claude-sonnet-4-6-thinking-max`
- **THEN** the resolved model is `claude-sonnet-4-6`

### Requirement: Non-gemini quota group attribution

Claude 4.6 models and all related aliases SHALL attribute to the `non-gemini`
quota group. Rate limit resets, touched tracking, and quota evaluations for
Claude SHALL NOT affect or inspect Gemini-family quota pools.

#### Scenario: Resolving quota group for Claude route

- **WHEN** `getQuotaGroupForModel` or `resolveQuotaGroup` is evaluated for
  `claude-sonnet-4-6` or `claude-opus-4-6-thinking`
- **THEN** the result is `non-gemini`
