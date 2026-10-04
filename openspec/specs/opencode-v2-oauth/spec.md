# OpenCode 2 OAuth Integration Specification

## Purpose

The adapter exposes Antigravity login through the OpenCode 2 integration
system (`ctx.integration.transform`): an OAuth method registered on the
`google` integration that appends every successful login to the shared account
pool. The loopback callback listener and token exchange are shared with the
rest of the repository.

## Requirements

### Requirement: Integration method registration

The plugin SHALL register, via `integration.transform`, an OAuth method with
integration id `google` and method id `antigravity-v2` labeled for adding an
Antigravity account, providing `authorize` and `refresh` handlers plus a
credential label.

#### Scenario: Host lists auth methods for the provider

- **WHEN** the host enumerates integration methods for `google`
- **THEN** the Antigravity OAuth method appears with its add-account label

### Requirement: Authorization flow (auto callback)

The `authorize` handler SHALL obtain an authorization URL from the shared
OAuth client, extract the `state` parameter, start the loopback callback
listener (fixed port 51121, path `/oauth-callback`, 10-minute timeout), and
return the URL with `mode: "auto"` and a callback promise that completes after
code exchange.

#### Scenario: User completes Google sign-in

- **WHEN** Google redirects to the callback with `code` and the expected
  `state`
- **THEN** the callback listener resolves with the code, acknowledges the
  browser without claiming the account was added, and shuts down

#### Scenario: Callback mismatches or times out

- **WHEN** the state does not match, Google reports an error, or no callback
  arrives within 10 minutes
- **THEN** the callback promise rejects with the corresponding error

#### Scenario: A retry while a previous attempt is still pending

- **WHEN** a new login attempt starts while a previous callback listener is
  still holding the fixed redirect port
- **THEN** the previous listener is closed (its pending promise rejects as
  superseded) and the new attempt binds the port, instead of failing with
  `EADDRINUSE`

#### Scenario: Another process holds the redirect port

- **WHEN** the callback port is occupied by an unrelated process
- **THEN** the listener rejects with an error naming the port and the conflict,
  rather than a bare bind failure

### Requirement: Account persistence on login

After a successful exchange the plugin SHALL append or re-enable the account
in the shared pool file (v4) under a lock-held write — keyed by email, or by
refresh token when no email is available — resetting ineligible and
verification flags, then reload the in-memory pool before returning the
credential.

#### Scenario: Existing disabled account logs in again

- **WHEN** the exchanged email matches an account marked ineligible or
  disabled
- **THEN** the account is re-enabled with fresh tokens and cleared failure
  flags

#### Scenario: Pool write fails

- **WHEN** persisting the account to disk throws
- **THEN** the OAuth callback rejects and the host surfaces the login failure

### Requirement: Credential refresh

The `refresh` handler SHALL refresh the access token from the credential's
refresh parts (refresh token, project id, managed project id), returning a new
`Credential.OAuth` that preserves the method id and any credential metadata.

#### Scenario: Host refreshes a stored credential

- **WHEN** the host invokes the refresh handler with an Antigravity credential
- **THEN** the returned credential carries a new access token and expiry with
  unchanged refresh parts and metadata

### Requirement: Pool reads and writes are shared and fail-closed

The plugin SHALL read and write the pool exclusively through the core storage
layer (v4 schema, fenced file lock), sharing state with the OpenCode 1
adapter and CLI. Unreadable pool files MUST fail closed rather than silently
treating the pool as empty.

#### Scenario: Pool file is corrupted

- **WHEN** the pool file cannot be parsed at plugin setup
- **THEN** the plugin logs the failure and starts with no accounts instead of
  rewriting or discarding the file
