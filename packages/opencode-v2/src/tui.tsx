// OpenCode 2 TUI plugin for the Antigravity adapter.
//
// The host imports the package's `./tui` export in the TUI process and calls
// `setup(context)` with the TUI plugin context. This plugin surfaces the
// shared account pool (same file the server plugin rotates over):
//
// - `prompt.footer.status` slot: one-line pool summary under the prompt.
// - `sidebar.footer` slot: per-account lines (READY / COOLDOWN / blocked).
// - Toast notifications when the pool changes (ineligible, validation,
//   cooldowns, enable/disable).
// - A palette command (`Antigravity: accounts`) opening a dialog to inspect
//   and enable/disable accounts.
//
// JSX here is compiled against the host's own OpenTUI runtime: the host
// loader rewrites `@opentui/solid/jsx-runtime` (and `solid-js`) to its
// embedded copies, so no Solid packages are shipped at runtime. Every host
// call is defensive — a TUI plugin must never take the TUI down.

import type {
  AccountStorageV4,
  AnyAccountStorage,
} from '@cortexkit/antigravity-auth-core'
import {
  loadAccountStorage,
  mutateAccountStorage,
} from '@cortexkit/antigravity-auth-core'
import type { Plugin as TuiPlugin } from '@opencode-ai/plugin/tui'

import { accountsFilePath } from './paths.ts'
import {
  type AccountPoolStatus,
  diffAccountPoolStatus,
  formatAccountLine,
  formatPoolSummaryLine,
  type PoolChange,
  summarizeAccountPool,
} from './pool-status.ts'

interface TuiPoolState {
  status: AccountPoolStatus | undefined
}

export interface OpenCodeV2TuiDependencies {
  loadPool: () => Promise<AnyAccountStorage | null>
  mutatePool: (
    mutate: (current: AccountStorageV4) => AccountStorageV4 | undefined,
  ) => Promise<AccountStorageV4>
  pollMs: number
  now: () => number
}

export type OpenCodeV2TuiDependencyOverrides =
  Partial<OpenCodeV2TuiDependencies>

const POLL_MS = 5_000

function defaultLoadPool(): Promise<AnyAccountStorage | null> {
  return loadAccountStorage(accountsFilePath()).catch(() => null)
}

function defaultMutatePool(
  mutate: (current: AccountStorageV4) => AccountStorageV4 | undefined,
): Promise<AccountStorageV4> {
  return mutateAccountStorage(accountsFilePath(), mutate)
}

function changeMessage(change: PoolChange): string {
  switch (change.kind) {
    case 'ineligible':
      return `${change.account} flagged ACCOUNT_INELIGIBLE`
    case 'verification':
      return `${change.account} requires validation`
    case 'disabled':
      return `${change.account} disabled`
    case 're-enabled':
      return `${change.account} re-enabled`
    case 'rate-limited':
      return `${change.account} rate-limited (${change.family ?? 'quota'}); rotating`
  }
}

export function createOpenCodeV2AntigravityTui(
  overrides: OpenCodeV2TuiDependencyOverrides = {},
): TuiPlugin.Definition {
  const dependencies: OpenCodeV2TuiDependencies = {
    loadPool: overrides.loadPool ?? defaultLoadPool,
    mutatePool: overrides.mutatePool ?? defaultMutatePool,
    pollMs: overrides.pollMs ?? POLL_MS,
    now: overrides.now ?? Date.now,
  }

  return {
    id: 'cortexkit.antigravity-auth.tui',

    async setup(ctx) {
      const [state, mutateState] = ctx.storage.memory<TuiPoolState>(
        'antigravity-pool',
        { initial: { status: undefined } },
      )
      let previous: AccountPoolStatus | undefined
      let keymapBound = false
      let refreshing = false

      const showToast = (
        message: string,
        variant: 'info' | 'warning',
      ): void => {
        try {
          ctx.ui.toast.show({
            title: 'Antigravity',
            message,
            variant,
          })
        } catch {
          // Toasts are best-effort; never let UI feedback break the plugin.
        }
      }

      const announce = (changes: readonly PoolChange[]): void => {
        if (changes.length === 0) return
        const warning = changes.some(
          (change) =>
            change.kind === 'ineligible' || change.kind === 'verification',
        )
        showToast(
          changes.map(changeMessage).join('; '),
          warning ? 'warning' : 'info',
        )
      }

      const refresh = async (): Promise<void> => {
        if (refreshing) return
        refreshing = true
        try {
          const storage = await dependencies.loadPool()
          const next = storage
            ? summarizeAccountPool(storage, dependencies.now())
            : undefined
          announce(diffAccountPoolStatus(previous, next ?? emptyStatus()))
          previous = next ?? undefined
          mutateState((draft) => {
            draft.status = next
          })
        } catch {
          mutateState((draft) => {
            draft.status = undefined
          })
        } finally {
          refreshing = false
        }
      }

      const openAccountsDialog = async (): Promise<void> => {
        const current = state.status
        if (!current || current.accounts.length === 0) {
          showToast('No Antigravity accounts in the pool', 'info')
          return
        }
        try {
          const selected = await ctx.ui.dialog.select<number>({
            title: 'Antigravity accounts',
            options: current.accounts.map((account) => ({
              title: formatAccountLine(account, dependencies.now()),
              value: account.index,
            })),
          })
          if (selected === undefined) return
          await dependencies.mutatePool((pool) => ({
            ...pool,
            accounts: pool.accounts.map((account, index) =>
              index === selected
                ? { ...account, enabled: account.enabled === false }
                : account,
            ),
          }))
          await refresh()
        } catch {
          // Dialog failures are non-fatal; the pool stays untouched.
        }
      }

      const bindKeymap = (): void => {
        if (keymapBound) return
        try {
          ctx.keymap.layer(() => ({
            commands: [
              {
                id: 'antigravity.accounts',
                title: 'Antigravity: accounts',
                description: 'Inspect and enable/disable pool accounts',
                group: 'Antigravity',
                // The beta's command palette does not surface keymap-layer
                // commands yet; the default binding keeps the dialog
                // reachable (verified against beta-19271).
                bind: 'ctrl+g',
                palette: true,
                run: () => {
                  void openAccountsDialog()
                },
              },
            ],
          }))
          keymapBound = true
        } catch {
          // Layer registration needs a component scope; retry on the next
          // slot render.
        }
      }

      const claims: Array<() => void> = []
      try {
        claims.push(
          ctx.ui.slot({
            append: 'prompt.footer.status',
            render: () => {
              bindKeymap()
              try {
                return summaryElement(state.status)
              } catch {
                return 'AGY'
              }
            },
          }),
        )
      } catch {
        // Slot surface unavailable in this host build; toasts still work.
      }
      try {
        claims.push(
          ctx.ui.slot({
            append: 'sidebar.footer',
            render: () => {
              try {
                return detailElement(state.status, dependencies.now())
              } catch {
                return 'AGY'
              }
            },
          }),
        )
      } catch {
        // Same as above.
      }

      await refresh()
      const timer = setInterval(() => {
        void refresh()
      }, dependencies.pollMs)
      timer.unref?.()

      return () => {
        clearInterval(timer)
        for (const dispose of claims) {
          try {
            dispose()
          } catch {
            // Ignore double-dispose from the host.
          }
        }
      }
    },
  }
}

function emptyStatus(): AccountPoolStatus {
  return {
    total: 0,
    ready: 0,
    cooling: 0,
    blocked: 0,
    disabled: 0,
    accounts: [],
    activeByFamily: {},
  }
}

function summaryElement(status: AccountPoolStatus | undefined) {
  if (!status) {
    return <text>AGY pool unavailable</text>
  }
  return <text>{formatPoolSummaryLine(status)}</text>
}

function detailElement(status: AccountPoolStatus | undefined, now: number) {
  if (!status || status.accounts.length === 0) {
    return <text>AGY: no accounts</text>
  }
  return (
    <box flexDirection='column'>
      {status.accounts.map((account) => (
        <text>{formatAccountLine(account, now)}</text>
      ))}
    </box>
  )
}

export default createOpenCodeV2AntigravityTui()
