# OpenCode 2 Request Bridge Specification

## Purpose

OpenCode 2 cannot return a custom response from the `session.hook('http.request')`
plugin hook, so the adapter rewrites each Antigravity model request to an
adapter-owned loopback HTTP server (`127.0.0.1`, ephemeral port) and lets the
host dispatch normally. The bridge performs the real Antigravity call through
the shared core transport and answers with Gemini-shaped payloads the native
`@opencode-ai/ai/providers/google` parser accepts.

## Requirements

### Requirement: Antigravity request interception

The plugin SHALL register a `session.hook('http.request')` handler that claims
exactly the requests issued for provider `google` whose model id is a routable
Antigravity model (or whose session request kind is `title`) and whose URL path
matches `models/*:(streamGenerateContent|generateContent)`. All other requests
MUST pass through unmodified.

#### Scenario: Non-Antigravity provider is untouched

- **WHEN** the host dispatches an `http.request` event for a provider other
  than `google`, or for a Google model outside the routable set
- **THEN** the hook returns without mutating `event.request`

#### Scenario: Title requests are rerouted to a cheap model

- **WHEN** a `title`-kind request arrives for any Google model
- **THEN** the bridge resolves the payload to the low-tier Antigravity flash
  model (`gemini-3.5-flash-low`, effectively `gemini-3.5-flash-extra-low`)
  before dispatch

#### Scenario: Streaming and non-streaming endpoints are distinguished

- **WHEN** the intercepted path ends in `streamGenerateContent` or
  `generateContent`
- **THEN** the pending job records `stream` accordingly so the loopback answers
  SSE or a single JSON body respectively

### Requirement: Loopback rewrite

The plugin SHALL replace the intercepted `event.request` with a `POST` to
`http://127.0.0.1:<port>/agy/<job-id>` carrying an empty JSON body, where the
port belongs to an ephemeral loopback server bound during plugin setup. Pending
jobs MUST expire after 10 minutes if the host never dispatches the rewritten
request.

#### Scenario: Rewritten request carries no credentials

- **WHEN** the hook replaces the original request (which carried the host's
  Google API key header)
- **THEN** the loopback request contains only `content-type: application/json`
  and no authorization or key headers

#### Scenario: Unknown job id is rejected

- **WHEN** the loopback server receives a request whose job id is missing or
  expired
- **THEN** it answers `404` with a JSON error body

### Requirement: Streaming response contract

For streaming jobs the bridge SHALL emit `text/event-stream` frames where each
frame is the sanitized inner Gemini event (the Antigravity
`{ "response": … }` envelope unwrapped), and SHALL end only after a frame with
a terminal `finishReason`.

#### Scenario: Clean EOF without terminal frame fails

- **WHEN** the upstream SSE stream ends without any candidate emitting
  `finishReason`
- **THEN** the bridge treats the response as failed instead of forwarding a
  truncated stream

#### Scenario: Embedded upstream error fails the stream

- **WHEN** an upstream SSE frame contains an `error` object
- **THEN** the bridge aborts the response (surfacing through the host error
  path) rather than emitting the frame

### Requirement: Non-streaming response contract

For non-streaming jobs the bridge SHALL collect the upstream SSE stream into a
single `application/json` `GenerateContentResponse` merged by candidate index,
including `usageMetadata` and `promptFeedback`.

#### Scenario: Host issues a generateContent call

- **WHEN** a job's path is `generateContent` (non-streaming)
- **THEN** the loopback answers with one JSON body of content type
  `application/json; charset=utf-8` and never with `text/event-stream`

### Requirement: Failure and abort mapping

The bridge SHALL answer `502` with a JSON error body when the Antigravity
exchange fails before any loopback byte is written, and SHALL destroy the
socket when a failure occurs mid-stream. When the host disconnects from the
loopback, the bridge MUST abort the upstream Antigravity request.

#### Scenario: Host cancels a generation

- **WHEN** the host closes the loopback connection while the upstream call is
  in flight
- **THEN** the in-flight upstream request is aborted and its resources released

### Requirement: Generated image persistence

The bridge SHALL replace `inlineData` image parts in responses with text
announcements pointing at files persisted under `~/.opencode/generated-images`
(permissions `0700` directory, `0600` files), because the native Gemini event
parser renders only text and tool calls.

#### Scenario: Model returns a generated image

- **WHEN** a response frame contains an image `inlineData` part
- **THEN** the part is written to disk with the matching extension and replaced
  by `[Antigravity image saved: <path>]`
