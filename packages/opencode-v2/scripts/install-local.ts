import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Install this working-tree build as a local OpenCode 2 plugin.
 *
 * OpenCode 2 discovers CLI/TUI plugins under `<config>/plugins/<name>/`, where
 * the server entry is `index.ts` and the TUI entry is `tui.ts`. The published
 * package exposes those through `exports["./server"]` / `exports["./tui"]`, but
 * the discovery loader does not follow a re-export to another package: the
 * entry files must sit inside the discovered directory. So we copy the built
 * modules in, renaming the two entrypoints to the names the loader expects and
 * keeping the helper modules they import.
 *
 * This is a dev-only install: re-run it after every build. It replaces only
 * the `antigravity-auth` directory, leaving other discovered plugins alone.
 */

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const DIST = join(PACKAGE_ROOT, 'dist')
const PLUGIN_ID = 'antigravity-auth'
const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), '.config', 'opencode')
const TARGET = join(CONFIG_DIR, 'plugins', PLUGIN_ID)

/** Built entrypoint -> name the discovery loader reads. */
const ENTRYPOINTS: Record<string, string> = {
  'plugin.js': 'index.ts',
  'tui.js': 'tui.ts',
}

if (!existsSync(DIST)) {
  throw new Error(`No build found at ${DIST}. Run \`bun run build\` first.`)
}

rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })

let copied = 0
for (const file of readdirSync(DIST)) {
  if (!file.endsWith('.js')) continue
  copyFileSync(join(DIST, file), join(TARGET, ENTRYPOINTS[file] ?? file))
  copied += 1
}

console.log(`Installed ${PLUGIN_ID} into ${TARGET}`)
console.log(
  `Copied ${copied} module(s); server entry = index.ts, TUI entry = tui.ts.`,
)
console.log('Restart OpenCode (or wait for the plugin watcher) to load it.')
