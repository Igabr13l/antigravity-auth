# Core AGY Transport Specification

## Purpose

`agy-transport.ts` is the shared low-level HTTP transport core uses to talk
to Antigravity. It replaces host `fetch` with a hand-rolled node:http
implementation over `tls.TLSSocket`: bounded header wait, an idle watchdog on
the response body, HTTPS-proxy CONNECT support, chunked request/response
encoding, and gzip decoding. Every network call from core (OAuth, quota,
loadCodeAssist, model probing) flows through it so timeouts, proxy handling,
and abort semantics behave identically across harnesses.

## Requirements

### Requirement: HTTPS-only direct or proxied transport

The transport SHALL only accept `https:` URLs and SHALL throw otherwise. When
`HTTPS_PROXY`/`https_proxy`/`ALL_PROXY`/`all_proxy` is set it SHALL tunnel
through an HTTP CONNECT with optional Basic auth derived from the proxy URL,
skipping the proxy when `NO_PROXY`/`no_proxy` matches the hostname (`*`, exact,
suffix, or dot-prefix entries). The TLS handshake and CONNECT response SHALL
each be bounded by the same header timeout.

#### Scenario: Proxy configured

- **WHEN** `HTTPS_PROXY` points at a proxy and the target is not in `NO_PROXY`
- **THEN** the transport sends `CONNECT host:443`, waits for a `2xx` response,
  then layers TLS over that socket with the target as `servername`

#### Scenario: Plain HTTP URL

- **WHEN** the caller passes an `http://` URL
- **THEN** the transport throws before opening any socket

### Requirement: CLI-shaped request serialization

Requests SHALL be serialized as `METHOD path HTTP/1.1` with a header block
containing `Host`, `User-Agent` (caller-supplied or the Antigravity harness
default), `Content-Type: application/json` unless overridden, and
`Accept-Encoding: gzip` unless overridden; `Authorization` passes through when
present. Non-streaming bodies SHALL use `Content-Length`; URLs containing
`:streamGenerateContent` SHALL use `Transfer-Encoding: chunked` instead and
wrap the body in a single chunk terminated by `0\r\n\r\n`. Bodies SHALL be
limited to string/`Uint8Array`/`ArrayBuffer`, defaulting to POST when no
method is set.

#### Scenario: Streaming request body

- **WHEN** the URL contains `:streamGenerateContent`
- **THEN** the serialized request has `Transfer-Encoding: chunked` and no
  `Content-Length` header

### Requirement: Header timeout and abort handling

The time to connect, establish TLS, and receive the full response header
block SHALL be bounded by `timeoutMs` (default
`DEFAULT_AGY_RESPONSE_HEADER_TIMEOUT_MS`, 180s); exceeding it SHALL destroy
the socket and reject with a timeout error. An already-aborted signal SHALL
reject before connecting, and an abort at any phase SHALL destroy the socket
with an `AbortError`.

#### Scenario: Server never sends headers

- **WHEN** the upstream accepts the socket but stays silent for `timeoutMs`
- **THEN** the fetch rejects with `Antigravity request timed out waiting for
  response headers after ...ms` and the socket is destroyed

### Requirement: Response head parsing and decoding pipeline

The response head SHALL be parsed for status, headers, `Transfer-Encoding:
chunked`, `Content-Encoding: gzip`, and a finite non-negative
`Content-Length`. Decoding SHALL pipe through chunk decoding when chunked,
exactly `contentLength` bytes via `ContentLengthStream` (discarding trailing
keep-alive bytes) when the length is known, then `createGunzip` when gzipped.
`Content-Length` SHALL be dropped from the surfaced headers when gzip is set
since the decoded length differs. A socket reset mid-body SHALL fail the last
decode stage with an explicit error rather than hanging the consumer.

#### Scenario: Gzipped chunked response

- **WHEN** the upstream answers `Transfer-Encoding: chunked` and
  `Content-Encoding: gzip`
- **THEN** the body stream is gunzipped after chunk decoding and no
  `content-length` header is surfaced

#### Scenario: Socket resets mid-body

- **WHEN** the socket errors after a partial body
- **THEN** the body stream fails with `Antigravity response body was cut off
  before it finished` instead of remaining open

### Requirement: Idle watchdog on the body

The response body stream SHALL arm an idle timer (default
`DEFAULT_AGY_IDLE_TIMEOUT_MS`, 180s) reset on every received chunk; on
expiry the socket SHALL be destroyed with `Antigravity response stalled: no
data for ...ms`. When the body ends normally the socket SHALL be destroyed and
all timers cleared.

#### Scenario: Stalled streaming response

- **WHEN** no body bytes arrive for `idleTimeoutMs`
- **THEN** the socket is destroyed and the consumer's read rejects
