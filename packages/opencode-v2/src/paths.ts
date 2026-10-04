// Shared filesystem paths for the OpenCode 2 adapter. Both the server plugin
// and the TUI plugin resolve the shared account pool, so the resolution rules
// must stay in one place. Mirrors the OpenCode 1 adapter's storage resolution:
// explicit env override, then the Windows config dir, then XDG, then ~/.config.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function configDir(): string {
  const explicit = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32' && process.env.APPDATA?.trim()) {
    const appdata = join(process.env.APPDATA.trim(), 'opencode')
    if (existsSync(join(appdata, 'antigravity-accounts.json'))) return appdata
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return xdg ? join(xdg, 'opencode') : join(homedir(), '.config', 'opencode')
}

export function accountsFilePath(): string {
  const explicit = process.env.ANTIGRAVITY_ACCOUNTS_FILE?.trim()
  if (explicit) return explicit
  return join(configDir(), 'antigravity-accounts.json')
}
