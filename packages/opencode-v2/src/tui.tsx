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

/** How a dialog toggle can be refused inside the lock-held write. */
type ToggleRefusal = 'missing' | 'ambiguous' | 'blocked'

/**
 * Thrown from inside the mutation callback. Rejecting the callback (rather than
 * returning the pool unchanged) is what stops `mutateAccountStorage` from
 * rewriting the file: it awaits the callback, so a throw unwinds before
 * `writeJsonAtomic`, leaving the on-disk pool genuinely untouched.
 */
class AccountToggleRefused extends Error {
  constructor(readonly reason: ToggleRefusal) {
    super(`account toggle refused: ${reason}`)
    this.name = 'AccountToggleRefused'
  }
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
        if (disposed) return
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
       * Refresh the pool with at most one queued read beyond the one in flight.
       *
       * Every caller is served by a read that starts no earlier than its own
       * request: a call that arrives while a read is running sets `refreshQueued`
       * and is satisfied by the next loop iteration, so a post-mutation refresh
       * never publishes a snapshot older than its own write. Timer ticks that
       * arrive during a slow read coalesce into that single queued read instead
       * of queueing unboundedly. Reads stop once the plugin is disposed.
       */
      let refreshQueued = false
      let refreshRunning: Promise<void> | undefined
      const refresh = (): Promise<void> => {
        refreshQueued = true
        refreshRunning ??= (async () => {
          try {
            while (refreshQueued && !disposed) {
              refreshQueued = false
              try {
                await readOnce()
              } catch {
                // A read that throws is treated like an unreadable pool:
                // publish unavailability and keep the last good baseline.
                if (disposed) return
                mutateState((draft) => {
                  draft.status = undefined
                })
              }
            }
          } finally {
            refreshRunning = undefined
          }
        })()
        return refreshRunning
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
          // The dialog applies the decision the displayed state implies instead
          // of inverting whatever is on disk. Inverting would let a stale
          // snapshot undo a concurrent change: the row read READY, another
          // process disabled the account, and a blind toggle would re-enable it.
          const desiredEnabled = snapshotState === 'disabled'
          try {
            await dependencies.mutatePool((pool) => {
              const matches: number[] = []
              pool.accounts.forEach((account, index) => {
                if (accountKey(account, index) === selected) matches.push(index)
              })
              if (matches.length === 0) {
                throw new AccountToggleRefused('missing')
              }
              if (matches.length > 1) {
                // Two accounts normalise to the same address key; toggling by
                // key would edit both. Refuse instead.
                throw new AccountToggleRefused('ambiguous')
              }
              const account = pool.accounts[matches[0]!]!
              // Re-check the block on the *fresh* record inside the lock: a
              // block can land between the dialog opening and this write.
              if (isAccountBlocked(account)) {
                throw new AccountToggleRefused('blocked')
              }
              return {
                ...pool,
                accounts: pool.accounts.map((candidate, index) =>
                  index === matches[0]
                    ? { ...candidate, enabled: desiredEnabled }
                    : candidate,
                ),
              }
            })
          } catch (error) {
            if (!(error instanceof AccountToggleRefused)) throw error
            switch (error.reason) {
              case 'missing':
                showToast(
                  'Account pool changed while the dialog was open; reopen it to retry',
                  'warning',
                )
                break
              case 'ambiguous':
                showToast(
                  'Multiple pool entries share this address; leaving the pool untouched',
                  'warning',
                )
                break
              case 'blocked':
                showToast(
                  'This account is now blocked by Google; resolve it before re-enabling',
                  'warning',
                )
                break
            }
            return
          }
          await refresh()
        } catch {
          // Dialog failures are non-fatal; the pool stays untouched.
        }
      }

      const ACCOUNTS_COMMAND_ID = 'antigravity.accounts'

      const bindKeymap = (): void => {
        // One layer for the whole TUI session, registered on the first slot
        // render (registration needs a component scope). Re-registering is not
        // an option: `ctx.keymap.commands()` never lists keymap-layer commands
        // on host 2.0.22, so any "is it still registered?" probe would always
        // answer no — and slot renders fire at high frequency (observed ~80/s
        // with reactive footer content), so per-render re-registration
        // accumulates thousands of layers and stalls the keymap dispatcher:
        // Ctrl+C (and every other bound key) stops responding.
        if (keymapBound) return
        try {
          ctx.keymap.layer(() => ({
            commands: [
              {
                id: ACCOUNTS_COMMAND_ID,
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
          // slot render until it succeeds once.
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
