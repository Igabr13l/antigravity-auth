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

import { createHash } from 'node:crypto'
import type {
  AccountMetadataV3,
  AccountStorageV4,
  AnyAccountStorage,
} from '@cortexkit/antigravity-auth-core'
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  aggregateQuota,
  aggregateQuotaSummary,
  fetchAvailableModels,
  fetchQuotaSummary,
  loadAccountStorage,
  mutateAccountStorage,
  refreshAntigravityToken,
} from '@cortexkit/antigravity-auth-core'
import type { Plugin as TuiPlugin } from '@opencode-ai/plugin/tui'

import { accountsFilePath } from './paths.ts'
import {
  type AccountPoolStatus,
  accountKey,
  attachQuota,
  diffAccountPoolStatus,
  displayAccountId,
  formatAccountLine,
  formatPoolSummaryLine,
  isAccountBlocked,
  isStableAccountKey,
  type PoolChange,
  type QuotaGroups,
  type SidebarRow,
  sidebarRows,
  summarizeAccountPool,
} from './pool-status.ts'

interface TuiPoolState {
  status: AccountPoolStatus | undefined
}

/** Minimal raw-account shape the quota fetcher needs from the pool. */
interface QuotaAccountLike {
  email?: string
  refreshToken?: string
  projectId?: string
  managedProjectId?: string
  enabled?: boolean
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
  /**
   * Fetch one account's quota aggregates. Network-bound; implementations are
   * expected to cache (the default fetcher caches per account for 2 minutes
   * and backs off on errors). Returning undefined means "no data this round".
   */
  fetchQuota: (account: QuotaAccountLike) => Promise<QuotaGroups | undefined>
}

export type OpenCodeV2TuiDependencyOverrides =
  Partial<OpenCodeV2TuiDependencies>

const POLL_MS = 5_000
/** How long a successful quota fetch is reused before hitting the API again. */
const QUOTA_TTL_MS = 120_000
/** Error backoff for quota fetches: 30s doubling up to 10 minutes. */
const QUOTA_BACKOFF_BASE_MS = 30_000
const QUOTA_BACKOFF_MAX_MS = 600_000

function defaultLoadPool(): Promise<AnyAccountStorage | null> {
  return loadAccountStorage(accountsFilePath()).catch(() => null)
}

function defaultMutatePool(
  mutate: (current: AccountStorageV4) => AccountStorageV4 | undefined,
): Promise<AccountStorageV4> {
  return mutateAccountStorage(accountsFilePath(), mutate)
}

function quotaCacheKey(account: QuotaAccountLike): string {
  const email = account.email?.trim().toLowerCase()
  if (email) return `e:${email}`
  const token = account.refreshToken ?? ''
  return `t:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a quota fetch failed because the access token was rejected (rather
 * than because the endpoint was transiently unavailable). Matching on the
 * message is the only signal the core fetchers expose: they fold the HTTP
 * status into the thrown error text.
 */
export function isQuotaAuthError(error: unknown): boolean {
  const message = messageOf(error)
  return /\b401\b/.test(message) || /unauthenticated/i.test(message)
}

interface QuotaFetcherState {
  cache: Map<string, { groups: QuotaGroups; fetchedAt: number }>
}

/** Injectable core calls, so tests can drive the auth retry without the network. */
export interface QuotaFetcherDependencies {
  refreshAntigravityToken: typeof refreshAntigravityToken
  fetchQuotaSummary: typeof fetchQuotaSummary
  fetchAvailableModels: typeof fetchAvailableModels
}

const DEFAULT_QUOTA_FETCHER_DEPENDENCIES: QuotaFetcherDependencies = {
  refreshAntigravityToken,
  fetchQuotaSummary,
  fetchAvailableModels,
}

/**
 * Default quota fetcher: in-memory per-account access-token cache, a 2-minute
 * result TTL, in-flight dedupe, and exponential error backoff (30s → 10min).
 * Access tokens stay in memory — the TUI plugin never writes the pool file.
 *
 * A token cached by `expires` can still be rejected by the API (revocation,
 * clock skew, a rotated server secret). Without a forced refresh the account's
 * quota would stay dark until the token's nominal expiry, so an auth failure
 * drops the token and retries once before backing off.
 */
export function createDefaultQuotaFetcher(
  deps: QuotaFetcherDependencies = DEFAULT_QUOTA_FETCHER_DEPENDENCIES,
): {
  fetch: (account: QuotaAccountLike) => Promise<QuotaGroups | undefined>
  state: QuotaFetcherState
} {
  const state: QuotaFetcherState = { cache: new Map() }
  const nextAttemptAt = new Map<string, number>()
  const failures = new Map<string, number>()
  const inflight = new Map<string, Promise<QuotaGroups | undefined>>()
  const tokens = new Map<string, { access: string; expires: number }>()

  const accessTokenFor = async (
    account: QuotaAccountLike,
    key: string,
    force = false,
  ): Promise<string | undefined> => {
    if (!account.refreshToken) return undefined
    const cached = tokens.get(key)
    if (!force && cached && cached.expires > Date.now() + 60_000) {
      return cached.access
    }
    const refreshed = await deps.refreshAntigravityToken(account.refreshToken)
    tokens.set(key, { access: refreshed.access, expires: refreshed.expires })
    return refreshed.access
  }

  /**
   * One quota read. Prefers the windowed summary and falls back to the legacy
   * per-model probe, but only for a non-auth failure: a rejected token fails
   * the legacy probe too, and masking it would hide the refresh trigger.
   */
  const loadGroups = async (
    account: QuotaAccountLike,
    access: string,
  ): Promise<QuotaGroups | undefined> => {
    try {
      const { summary } = await deps.fetchQuotaSummary({
        accessToken: access,
        endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
        projectId: account.projectId,
        managedProjectId: account.managedProjectId,
      })
      return aggregateQuotaSummary(summary).groups
    } catch (error) {
      if (isQuotaAuthError(error)) throw error
      // Legacy contract fallback: aggregate per-model quotas from
      // fetchAvailableModels (mirrors the OpenCode 1 adapter's order).
      const models = await deps.fetchAvailableModels({
        accessToken: access,
        endpoints: ANTIGRAVITY_ENDPOINT_FALLBACKS,
        // Empty string: the fetcher omits the project field for falsy IDs.
        projectId: account.projectId ?? '',
      })
      return aggregateQuota(models.models).groups
    }
  }

  const fetch = async (
    account: QuotaAccountLike,
  ): Promise<QuotaGroups | undefined> => {
    if (account.enabled === false) return undefined
    const key = quotaCacheKey(account)
    const now = Date.now()
    const cached = state.cache.get(key)
    if (cached && now - cached.fetchedAt < QUOTA_TTL_MS) return cached.groups
    if ((nextAttemptAt.get(key) ?? 0) > now) return cached?.groups
    const running = inflight.get(key)
    if (running) return running

    const task = (async (): Promise<QuotaGroups | undefined> => {
      try {
        let access = await accessTokenFor(account, key)
        if (!access) return cached?.groups
        let groups: QuotaGroups | undefined
        try {
          groups = await loadGroups(account, access)
        } catch (error) {
          // Rejected-but-unexpired token: refresh once and retry.
          if (!isQuotaAuthError(error)) throw error
          access = await accessTokenFor(account, key, true)
          if (!access) throw error
          groups = await loadGroups(account, access)
        }
        if (groups && Object.keys(groups).length > 0) {
          state.cache.set(key, { groups, fetchedAt: Date.now() })
          failures.delete(key)
          nextAttemptAt.delete(key)
          return groups
        }
        return cached?.groups
      } catch {
        const count = (failures.get(key) ?? 0) + 1
        failures.set(key, count)
        nextAttemptAt.set(
          key,
          Date.now() +
            Math.min(
              QUOTA_BACKOFF_BASE_MS * 2 ** (count - 1),
              QUOTA_BACKOFF_MAX_MS,
            ),
        )
        return cached?.groups
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, task)
    return task
  }

  return { fetch, state }
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
  const defaultQuotaFetcher = createDefaultQuotaFetcher()
  const dependencies: OpenCodeV2TuiDependencies = {
    loadPool: overrides.loadPool ?? defaultLoadPool,
    mutatePool: overrides.mutatePool ?? defaultMutatePool,
    pollMs: overrides.pollMs ?? POLL_MS,
    now: overrides.now ?? Date.now,
    fetchQuota: overrides.fetchQuota ?? defaultQuotaFetcher.fetch,
  }

  return {
    id: 'cortexkit.antigravity-auth.tui',

    async setup(ctx) {
      const [state, mutateState] = ctx.storage.memory<TuiPoolState>(
        'antigravity-pool',
        { initial: { status: undefined } },
      )
      const [viewState, setViewState] = ctx.storage.store
        ? ctx.storage.store<{ open: boolean }>('antigravity-sidebar-view', {
            initial: { open: true },
          })
        : ctx.storage.memory<{ open: boolean }>('antigravity-sidebar-view', {
            initial: { open: true },
          })
      let lastToggleTime = 0
      const toggleOpen = (): void => {
        const currentTime = Date.now()
        if (currentTime - lastToggleTime < 300) return
        lastToggleTime = currentTime
        try {
          const res: unknown = setViewState((draft) => {
            draft.open = !(draft.open ?? true)
          })
          if (res instanceof Promise) {
            res.catch(() => {})
          }
        } catch {
          // Best-effort toggle
        }
      }
      let previous: AccountPoolStatus | undefined
      let keymapBound = false
      let disposed = false
      /** Resolved quota aggregates by stable account key (in-memory only). */
      const quotaByKey = new Map<string, QuotaGroups>()

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
        const summarized = summarizeAccountPool(storage, dependencies.now())
        // Merge whatever quota already resolved (network refresh runs
        // out-of-band below and lands on a later poll, ≤5s later, so the 5s
        // pool read never waits on the API).
        const next = attachQuota(summarized, quotaByKey)
        announce(diffAccountPoolStatus(previous, next))
        previous = next
        mutateState((draft) => {
          draft.status = next
        })
        void refreshQuotas(storage)
      }

      /**
       * Out-of-band quota refresh: one bounded fetch per account, deduped and
       * TTL'd inside the fetcher. Fire-and-forget — resolved aggregates are
       * stored by stable account key and surface on the next pool read (≤5s).
       * Never re-enters refresh() directly, so a fast cached round cannot
       * loop.
       */
      const refreshQuotas = async (
        storage: AnyAccountStorage,
      ): Promise<void> => {
        if (disposed) return
        const rawAccounts: AccountMetadataV3[] =
          storage.version === 4 ? storage.accounts : []
        await Promise.allSettled(
          rawAccounts.map(async (raw, index) => {
            const groups = await dependencies.fetchQuota(raw)
            if (groups) quotaByKey.set(accountKey(raw, index), groups)
          }),
        )
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
              title: formatAccountLine(
                account,
                dependencies.now(),
                activeFamiliesFor(current, account),
              ),
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
            prepend: 'sidebar.footer',
            render: () => {
              // Both slots retry the bind: the layer needs a component scope,
              // so whichever surface the host mounts first wins. Binding from
              // one slot only would leave ctrl+g dead whenever the other slot
              // fails to register.
              bindKeymap()
              try {
                return detailElement(
                  state.status,
                  dependencies.now(),
                  viewState.open ?? true,
                  toggleOpen,
                )
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

function detailElement(
  status: AccountPoolStatus | undefined,
  now: number,
  open: boolean = true,
  toggle?: () => void,
) {
  if (!status || status.accounts.length === 0) {
    return <text>AGY: no accounts</text>
  }
  const glyph = open ? '▼' : '▶'
  const summary =
    status.ready === status.total
      ? `${status.total} ready`
      : `${status.ready}/${status.total} ready`

  const rows: SidebarRow[] = []
  if (open) {
    status.accounts.forEach((account, idx) => {
      rows.push(
        ...sidebarRows(account, now, activeFamiliesFor(status, account)),
      )
      if (idx < status.accounts.length - 1) {
        rows.push({ text: ' ' })
      }
    })
  }

  return (
    <box flexDirection='column'>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui renders to a terminal, not the DOM — ARIA roles do not apply */}
      <box flexDirection='row' gap={1} onMouseDown={toggle} onMouseUp={toggle}>
        <text fg='#94a3b8'>{glyph} Antigravity</text>
        {!open && <text fg='#64748b'>({summary})</text>}
      </box>
      {open && (
        <box flexDirection='column'>
          {rows.map((row) => (
            <text fg={row.fg}>{row.text}</text>
          ))}
        </box>
      )}
    </box>
  )
}

/**
 * Families whose active pool index currently points at this account. The
 * active marker is what tells the operator which account their traffic is
 * actually using right now.
 */
export function activeFamiliesFor(
  status: AccountPoolStatus,
  account: AccountPoolStatus['accounts'][number],
): string[] {
  const families: string[] = []
  for (const family of ['claude', 'gemini'] as const) {
    if (status.activeByFamily[family] === account.index) {
      families.push(family)
    }
  }
  return families
}

export default createOpenCodeV2AntigravityTui()
