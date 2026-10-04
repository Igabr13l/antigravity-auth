# OpenCode 2 Plugin Packaging Specification

## Purpose

The adapter ships as an npm package (`@cortexkit/opencode-v2-antigravity-auth`)
consumed by the OpenCode 2 host's promise-plugin loader. The package must
satisfy the host's cross-platform entrypoint resolution (`Host.resolve`) with a
functional server plugin and TUI status plugin while never dragging the host
SDK or UI runtimes into consumer installs.

## Requirements

### Requirement: Promise plugin contract

The package's default export SHALL satisfy the OpenCode 2 promise plugin
contract: an object with a stable `id` (`cortexkit.antigravity-auth`) and a
`setup(context)` function that returns a teardown performing full cleanup
(hook disposal, loopback shutdown, in-flight aborts, pool flush).

#### Scenario: Host loads the plugin

- **WHEN** the OpenCode 2 host imports the resolved server entry and calls
  `setup`
- **THEN** the plugin registers its session hooks and integration OAuth method
  and returns a teardown that disposes every registration it created

### Requirement: oc-plugin entrypoint resolution

The package manifest SHALL declare `"oc-plugin": ["server", "tui"]` and expose
`./server` and `./tui` pointing at the built plugins, plus a resolvable `./rpc`
export. The server entry owns request routing and OAuth; the TUI entry is the
pool status plugin (see the `opencode-v2-tui-status` spec). The RPC module MUST
stay an inert placeholder so the host's cross-platform resolver probing never
registers unwanted RPC registrations.

#### Scenario: Host resolver probes all three entrypoints

- **WHEN** `Host.resolve({ directory, name })` runs against the installed
  package
- **THEN** it returns a server entry and a TUI entry inside the installed
  package plus an RPC entry, and importing the RPC default yields the inert
  placeholder export

#### Scenario: Packed package resolves identically

- **WHEN** the smoke test packs core and the adapter with `bun pm pack` and
  installs them into an isolated consumer
- **THEN** `Host.resolve` discovers the server and TUI entries within the
  installed package, the packed manifest retains `files` and `oc-plugin`, the
  server entry imports and exposes `setup`, and the host plugin SDK is absent
  from the consumer's `node_modules`

### Requirement: Configuration contract

The package README and `example/opencode.json` SHALL instruct users to
register the package under the plural `plugins` key of `opencode.json` (the
OpenCode 2 configuration shape) and to declare the `google` provider with the
Antigravity model map (id, `package: "@opencode-ai/ai/providers/google"`,
capabilities, limits, variants).

#### Scenario: Example config matches the routing set

- **WHEN** the drift-guard test compares `example/opencode.json` against the
  bridge's routable model set
- **THEN** the declared `providers.google.models` keys and the registered
  plugin name are exactly the ones the bridge routes

### Requirement: Host SDK isolation

The package SHALL depend only on `@cortexkit/antigravity-auth-core` at runtime;
`@opencode-ai/plugin` MUST remain a devDependency used for types and tests
only.

#### Scenario: Consumer install stays minimal

- **WHEN** the packed package is installed into a fresh consumer
- **THEN** `@opencode-ai/plugin` is not installed under the consumer's
  `node_modules`
