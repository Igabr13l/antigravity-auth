// Discovery-loader shim for a `file://` package-directory plugin reference.
//
// The OpenCode 2 loader resolves a directory plugin's entries as
// `<dir>/index.ts` (server) and `<dir>/tui.ts` (TUI) — it does not follow the
// package `exports` map (`./server` / `./tui`) to `dist/`. Published installs
// get these files via `scripts/install-local.ts`, which copies the built
// modules under `<config>/plugins/antigravity-auth/`. This shim gives the
// direct `file://…/packages/opencode-v2` dev form the same entry files without
// a copy step; it must not be published (kept out of the package `files`).
export { default, createOpenCodeV2AntigravityTui } from './dist/tui.js'
