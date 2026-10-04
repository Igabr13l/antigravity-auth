# OpenCode 2 Antigravity Envelope Specification

## Purpose

Antigravity upstream expects a strict Gemini-shaped payload inside a
`{ project, requestId, request, model, userAgent, requestType }` envelope with
agent request metadata. The bridge transforms the host's native Gemini payload
into that envelope, preserving the wire invariants shared with the OpenCode 1
adapter: Claude thinking is regenerated fresh, tool schemas are sanitized,
function-call signatures are managed explicitly, and a trailing user turn
closes every conversation.

## Requirements

### Requirement: Envelope construction

The bridge SHALL clone the host payload, strip host-only fields (`model`,
`project`, `providerOptions`, `user_prompt_id`, `session_id`), set the
Antigravity identity fields (`userAgent: "antigravity"`,
`requestType: "agent"`, effective project id), and attach request metadata
(labels, session id, request id, ordering) built from the shared core
request-metadata module.

#### Scenario: Host options do not leak upstream

- **WHEN** the host payload contains `providerOptions` or internal ids
- **THEN** the outgoing envelope request omits them

### Requirement: Thinking configuration mapping

The bridge SHALL map the resolved model's thinking tier to
`generationConfig.thinkingConfig` (`includeThoughts: true` plus
`thinkingLevel` or `thinkingBudget`) and SHALL remove any host-provided
thinking config before applying model-family transforms.

#### Scenario: Tiered flash model request

- **WHEN** a request resolves to a model with a thinking level
- **THEN** the envelope's `generationConfig.thinkingConfig` carries that level
  with `includeThoughts: true`

### Requirement: Claude family transforms

For Claude-family models the bridge SHALL strip ALL inbound thinking blocks
(Claude regenerates fresh thinking each turn, eliminating signature validation
errors), apply the shared Claude transforms with the core schema cleaner, and
pin `generationConfig.maxOutputTokens` to the Claude thinking maximum
(64 000).

#### Scenario: Conversation replay containing foreign thinking

- **WHEN** the payload carries historical parts marked `thought: true` with
  `thoughtSignature`
- **THEN** the outgoing Claude request contains no inbound thinking parts

### Requirement: Tool configuration and schema sanitization

When tools are present the bridge SHALL set
`toolConfig.functionCallingConfig.mode = "VALIDATED"`; when no tools remain it
SHALL remove `toolConfig`. Tool schemas SHALL be normalized through the shared
sanitizers (unsupported JSON-Schema fields removed or converted), with numeric
constraints moved to descriptions for GPT-family targets. Gemini's Schema proto
has no exclusive-bound fields, so `exclusiveMinimum`/`exclusiveMaximum` SHALL be
moved to descriptions for every target, not only GPT-family ones.

#### Scenario: Host sends tools

- **WHEN** the payload includes function declarations
- **THEN** the outgoing request declares `VALIDATED` tool calling mode and
  contains only Antigravity-compatible schema fields

#### Scenario: Tool schema carries exclusive numeric bounds

- **WHEN** a declaration's schema contains `exclusiveMinimum` or
  `exclusiveMaximum` on a Gemini-family target
- **THEN** the outgoing request contains no exclusive-bound field and the bound
  survives as a description hint, so Antigravity's strict protobuf validation
  cannot reject the payload with 400 INVALID_ARGUMENT

### Requirement: Function-call signature policy

The bridge SHALL keep at most the first function call's `thoughtSignature` per
content, replacing missing or short (<50 chars) signatures with the
`SKIP_THOUGHT_SIGNATURE` sentinel and stripping signatures from subsequent
parallel calls. When a continuation targets the same model as the previous
request in the session, existing valid signatures on function calls SHALL be
replayed in order.

#### Scenario: Parallel tool calls in history

- **WHEN** a content part list contains multiple function calls
- **THEN** only the first carries a signature (valid or sentinel) and the rest
  have none

#### Scenario: Same-model continuation

- **WHEN** the previous routed request for the session used the same actual
  model
- **THEN** original function-call signatures are replayed before the policy is
  enforced

### Requirement: Trailing user turn

The bridge SHALL append a `user` turn with the text `[Continue]` whenever the
payload's last content is a model turn (role `model` or `assistant`), so
Antigravity never receives a conversation ending on the model side. Contents
whose parts are exclusively `functionResponse` SHALL be normalized to role
`model`.

#### Scenario: Interrupted session replay

- **WHEN** the payload ends with a model turn, for example an unanswered
  function call after an interrupted tool run
- **THEN** the outgoing request closes with a synthetic `[Continue]` user turn

### Requirement: Image generation requests

For image-generation models the bridge SHALL replace tools and tool config
with the shared image generation config (`imageConfig`, `candidateCount`),
drop thinking config, and install a fixed image-generator system instruction.

#### Scenario: Image model invocation

- **WHEN** the resolved model is `gemini-3.1-flash-image`
- **THEN** the envelope carries image generation config and no function
  declarations
