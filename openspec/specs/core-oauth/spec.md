# Core OAuth Specification

## Purpose

`antigravity/oauth.ts` owns the Antigravity OAuth 2.0 flow: PKCE authorization
URL construction, code-for-token exchange, user-info lookup, project-ID
resolution, and access-token refresh. It is harness-agnostic — the exchange
returns credentials and the refresh token, and callers (OpenCode 1, OpenCode
2, Pi, CLI) own persistence and caching. Failures are converted into typed
results or errors, never silent `undefined`s.

## Requirements

### Requirement: PKCE authorization URL

`authorizeAntigravity` SHALL generate a 32-byte base64url verifier, derive the
S256 challenge as base64url(sha256(verifier)), and build an authorization URL
against `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`,
`access_type=offline`, `prompt=consent`, the Antigravity client id, redirect
URI, and scopes. The `state` parameter SHALL be base64url(JSON) carrying the
verifier and optional `projectId`.

#### Scenario: Building the consent URL

- **WHEN** `authorizeAntigravity('proj-1')` is called
- **THEN** the returned URL has `code_challenge_method=S256`, the state
  decodes to `{ verifier, projectId: 'proj-1' }`, and the same verifier is
  returned to the caller

### Requirement: State decoding contract

`decodeState` SHALL accept both base64url and base64-ish state strings (adding
back padding), parse the JSON payload, and throw `Missing PKCE verifier in
state` when `verifier` is absent; a missing or non-string `projectId`
degrades to `''`.

#### Scenario: State without padding

- **WHEN** the callback returns an unpadded base64url state
- **THEN** exchange succeeds and the verifier round-trips intact

### Requirement: Token exchange

`exchangeAntigravity(code, state)` SHALL POST to
`https://oauth2.googleapis.com/token` with `grant_type=authorization_code`,
the client id/secret, redirect URI, and the state-derived `code_verifier`. On
a non-OK response it SHALL return `{ type: 'failed', error: <body> }`; on a
missing refresh token it SHALL return `{ type: 'failed', error: 'Missing
refresh token in response' }`; any thrown error (bad state, network) SHALL
also surface as `{ type: 'failed', error: message }`. On success it SHALL
return `{ type: 'success', refresh, access, expires, email, label, projectId }`
where `refresh` is stored as `` `${refreshToken}|${projectId}` ``,
`expires` is computed from the token response `expires_in`, `email`/`label`
come from the userinfo endpoint (best-effort; failure yields `{}`), and
`label` is the trimmed user name or `undefined`.

#### Scenario: Missing refresh token

- **WHEN** the token endpoint answers 200 but omits `refresh_token`
- **THEN** the result is `{ type: 'failed', error: 'Missing refresh token in
  response' }`

### Requirement: Project resolution

When the caller supplies no `projectId`, exchange SHALL resolve it by POSTing
`{ metadata }` to `/v1internal:loadCodeAssist` with the bootstrap headers,
walking `ANTIGRAVITY_LOAD_ENDPOINTS` ∪ `ANTIGRAVITY_ENDPOINT_FALLBACKS` with
a 10s per-endpoint timeout. A string `cloudaicompanionProject` or
`cloudaicompanionProject.id` SHALL be used; if every endpoint fails, the
errors are logged and `projectId` degrades to `''` rather than throwing.

#### Scenario: Primary loadCodeAssist endpoint errors

- **WHEN** the first endpoint fails and the second returns a project id
- **THEN** the second's project id is stored in the `refresh|projectId`
  credential

### Requirement: Token refresh

`refreshAntigravityToken` SHALL POST `grant_type=refresh_token` to
`https://oauth2.googleapis.com/token`. On non-OK it SHALL throw with the
status and a body snippet. On success it SHALL return the new access token,
keep the old refresh token when the response omits `refresh_token`, and
compute `expires` from `expires_in` against the request start time. It SHALL
perform no persistence.

#### Scenario: Refresh response rotates the refresh token

- **WHEN** the response includes a new `refresh_token`
- **THEN** the result's `refresh` is the new token; when omitted, the
  original token is preserved
