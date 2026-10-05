// Discovery-loader shim for a `file://` package-directory plugin reference:
// the server entry must sit at `<dir>/index.ts` (see ./tui.ts). Dev-only; not
// part of the published package.
export { default } from './dist/plugin.js'
