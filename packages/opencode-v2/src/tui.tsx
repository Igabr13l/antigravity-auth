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
  accountKey,
  diffAccountPoolStatus,
  displayAccountId,
  formatAccountLine,
  formatPoolSummaryLine,
  isAccountBlocked,
  isStableAccountKey,
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
      let refreshChain: Promise<void> = Promise.resolve()
      let disposed = false

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

      const readOnce = async (): Promise<void> => {
        const storage = await dependencies.loadPool()
        if (disposed) return
        if (!storage) {
          // Unreadable right now. Keep the last good baseline so the next
          // successful read can report what changed during the gap, and render
          // unavailability rather than an empty snapshot.
          mutateState((draft) => {
            draft.status = undefined
          })
          return
        }
        const next = summarizeAccountPool(storage, dependencies.now())
        announce(diffAccountPoolStatus(previous, next))
        previous = next
        mutateState((draft) => {
          draft.status = next
        })
      }

      /**
       * Read the pool, serialising every caller behind the previous read so a
       * slow read can never race a newer one. Each caller still triggers a
       * fresh read after all prior reads, so a caller that mutates and then
       * refreshes never publishes a snapshot older than its own write. The
       * reads are cheap (a local, lock-held pool file), so chaining them is
       * safe; we deliberately do not coalesce away a caller's own read.
       */
      const refresh = (): Promise<void> => {
        const run = refreshChain.then(async () => {
          try {
            await readOnce()
          } catch {
            // A read that throws is treated like an unreadable pool: publish
            // unavailability and keep the last good baseline for recovery.
            if (disposed) return
            mutateState((draft) => {
              draft.status = undefined
            })
          }
        })
        refreshChain = run.catch(() => {})
        return run
      }

      const openAccountsDialog = async (): Promise<void> => {
        const current = state.status
        if (!current || current.accounts.length === 0) {
          showToast('No Antigravity accounts in the pool', 'info')
          return
        }
        try {
          const selected = await ctx.ui.dialog.select<string>({
            title: 'Antigravity accounts',
            options: current.accounts.map((account) => ({
              title: formatAccountLine(account, dependencies.now()),
              value: account.key,
            })),
          })
          if (selected === undefined) return
          const target = current.accounts.find(
            (account) => account.key === selected,
          )
          if (!target) return
          // An index-derived key identifies its account only by position, so
          // we cannot use it to write safely: after a concurrent add or remove
          // the same key may now name a different account. Fail closed rather
          // than editing the wrong record.
          if (!isStableAccountKey(selected)) {
            showToast(
              'This account has no address on file, so its identity can shift. Add the account email before toggling it from the TUI.',
              'warning',
            )
            return
          }
          const snapshotState = target.state
          if (
            snapshotState === 'ineligible' ||
            snapshotState === 'verification'
          ) {
            showToast(
              snapshotState === 'ineligible'
                ? `${displayAccountId(target)} is blocked by Google (ACCOUNT_INELIGIBLE); resolve it before re-enabling`
                : `${displayAccountId(target)} needs Google account validation; complete it before re-enabling`,
              'warning',
            )
            return
          }
          let outcome: 'ok' | 'missing' | 'ambiguous' | 'blocked' = 'missing'
          await dependencies.mutatePool((pool) => {
            const matches: number[] = []
            pool.accounts.forEach((account, index) => {
              if (accountKey(account, index) === selected) matches.push(index)
            })
            if (matches.length === 0) {
              outcome = 'missing'
              return undefined
            }
            if (matches.length > 1) {
              // Two accounts normalise to the same address key; toggling by
              // key would edit both. Leave the pool untouched instead.
              outcome = 'ambiguous'
              return undefined
            }
            const account = pool.accounts[matches[0]!]!
            // Re-check the block on the *fresh* record inside the lock: a
            // block can land between the dialog opening and this write.
            if (isAccountBlocked(account)) {
              outcome = 'blocked'
              return undefined
            }
            outcome = 'ok'
            return {
              ...pool,
              accounts: pool.accounts.map((candidate, index) =>
                index === matches[0]
                  ? { ...candidate, enabled: candidate.enabled === false }
                  : candidate,
              ),
            }
          })
          const finalOutcome = outcome as
            | 'ok'
            | 'missing'
            | 'ambiguous'
            | 'blocked'
          if (finalOutcome === 'ok') {
            await refresh()
            return
          }
          if (finalOutcome === 'missing') {
            showToast(
              'Account pool changed while the dialog was open; reopen it to retry',
              'warning',
            )
          } else if (finalOutcome === 'ambiguous') {
            showToast(
              'Multiple pool entries share this address; leaving the pool untouched',
              'warning',
            )
          } else {
            showToast(
              'This account is now blocked by Google; resolve it before re-enabling',
              'warning',
            )
          }
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
              // Both slots retry the bind: the layer needs a component scope,
              // so whichever surface the host mounts first wins. Binding from
              // one slot only would leave ctrl+g dead whenever the other slot
              // fails to register.
              bindKeymap()
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
        disposed = true
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
