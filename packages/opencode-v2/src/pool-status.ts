// Pure derivation of the shared account pool into TUI-displayable status.
//
// Redaction rule (mirrors core): account `label` may contain personal
// information and never crosses this boundary — accounts are identified by
// masked email, falling back to pool index.

import { createHash } from 'node:crypto'

import type {
  AccountStorageV4,
  AnyAccountStorage,
  QuotaGroupSummary,
} from '@cortexkit/antigravity-auth-core'

/** Per-family quota aggregates for one account (gemini + claude/gpt-oss). */
export type QuotaGroups = Partial<
  Record<'gemini' | 'non-gemini', QuotaGroupSummary>
>

export type AccountState =
  | 'ready'
  | 'rate-limited'
  | 'ineligible'
  | 'verification'
  | 'disabled'

export interface AccountStatus {
  /**
   * Stable, opaque identity used to match an account across polls. Pool indices
   * are positional and shift when an account is added or removed, so change
   * detection must never key on them.
   */
  readonly key: string
  readonly index: number
  readonly maskedEmail: string | undefined
  readonly state: AccountState
  /**
   * Quota families and/or cooldown reasons currently cooling this account,
   * e.g. `claude`, `gemini-antigravity`, `auth-failure`.
   */
  readonly coolingFamilies: readonly string[]
  /** Latest instant at which any cooldown for this account ends. */
  readonly cooldownUntil: number
  /** Cached quota aggregates, attached by the caller when available. */
  readonly quota?: QuotaGroups
}

export interface AccountPoolStatus {
  readonly total: number
  readonly ready: number
  readonly cooling: number
  readonly blocked: number
  readonly disabled: number
  readonly accounts: readonly AccountStatus[]
  readonly activeByFamily: { claude?: number; gemini?: number }
}

export type PoolChangeKind =
  | 'disabled'
  | 'ineligible'
  | 'verification'
  | 'rate-limited'
  | 're-enabled'

export interface PoolChange {
  readonly kind: PoolChangeKind
  /** Display id of the affected account (masked email or `#index`). */
  readonly account: string
  readonly family?: string
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at)
  const head = local.slice(0, 1)
  return `${head}***${domain}`
}

export function displayAccountId(account: AccountStatus): string {
  return account.maskedEmail ?? `#${account.index}`
}

function cooldownFamilies(
  resets: Record<string, number | undefined> | undefined,
  now: number,
): string[] {
  if (!resets) return []
  return Object.entries(resets)
    .filter((entry): entry is [string, number] => {
      const [, until] = entry
      return typeof until === 'number' && until > now
    })
    .map(([family]) => family)
}

type PoolAccount = AnyAccountStorage['accounts'][number]

function enabledOf(account: PoolAccount): boolean {
  return 'enabled' in account ? account.enabled !== false : true
}

function emailOf(account: PoolAccount): string | undefined {
  if (!('email' in account) || typeof account.email !== 'string')
    return undefined
  const email = account.email.trim()
  return email.length > 0 ? email : undefined
}

/**
 * Stable identity for an account, independent of its position in the pool.
 *
 * The raw address never leaves this module (see the redaction note above), so
 * the key is a truncated digest instead of the email itself. Hashing the email
 * — rather than the refresh token — keeps the key stable across a bare
 * refresh-token rotation, which core performs in place. Accounts with no email
 * fall back to their index, which only holds while pool membership is
 * unchanged; a caller that mutates on this fallback must fail closed rather
 * than guess.
 */
export function accountKey(account: PoolAccount, index: number): string {
  const email = emailOf(account)
  if (email) {
    const digest = createHash('sha256')
      .update(email.toLowerCase())
      .digest('hex')
    return `e:${digest.slice(0, 12)}`
  }
  // Fallback: hash the refresh token prefix (stable across pool reordering,
  // unlike `#${index}` which is positional). Refresh token is always present
  // in a valid stored account.
  const token = account.refreshToken
  if (token) {
    const digest = createHash('sha256').update(token.slice(0, 16)).digest('hex')
    return `t:${digest.slice(0, 12)}`
  }
  return `#${index}`
}

function resetsOf(account: PoolAccount): Record<string, number | undefined> {
  const resets: Record<string, number | undefined> = {}
  if ('rateLimitResetTimes' in account && account.rateLimitResetTimes) {
    for (const [family, until] of Object.entries(account.rateLimitResetTimes)) {
      resets[family] = until
    }
  }
  // V4 also persists an account-wide cooldown that is independent of the
  // per-family rate limits (auth failure, network error, project error,
  // validation). core excludes such an account from selection in
  // `isAccountCoolingDown()`, so reporting it as READY would tell the operator
  // an account is usable while the router is refusing to dispatch to it.
  if (
    'coolingDownUntil' in account &&
    typeof account.coolingDownUntil === 'number'
  ) {
    const reason =
      'cooldownReason' in account && typeof account.cooldownReason === 'string'
        ? account.cooldownReason
        : 'account'
    resets[reason] = Math.max(resets[reason] ?? 0, account.coolingDownUntil)
  }
  return resets
}

function isIneligible(account: PoolAccount): boolean {
  return 'accountIneligible' in account && account.accountIneligible === true
}

function isVerificationRequired(account: PoolAccount): boolean {
  return (
    'verificationRequired' in account && account.verificationRequired === true
  )
}

/**
 * A Google-side block (`ACCOUNT_INELIGIBLE` or awaiting validation). The
 * dialog's mutator calls this on the *fresh* record, not the dialog snapshot,
 * so a block that lands while the dialog is open is still honoured.
 */
export function isAccountBlocked(account: PoolAccount): boolean {
  return isIneligible(account) || isVerificationRequired(account)
}

/**
 * Whether a key is safe to mutate on. Index-derived keys (`#<index>`) are
 * positional: after a concurrent add or remove they can identify a different
 * account. A volatile key must never be used to write — fail closed instead.
 */
export function isStableAccountKey(key: string): boolean {
  return key.startsWith('e:')
}

export function summarizeAccountPool(
  storage: AnyAccountStorage,
  now: number,
): AccountPoolStatus {
  const accounts = storage.accounts.map((account, index): AccountStatus => {
    const email = emailOf(account)
    const resets = resetsOf(account)
    const cooling = cooldownFamilies(resets, now)
    let state: AccountState = 'ready'
    // Precedence matters: core disables an account as it applies a Google-side
    // block (`markAccountIneligible` / `requestVerification` both call
    // `setAccountEnabled(index, false)`), so `enabled === false` is a symptom
    // of the block rather than an operator decision. Checking `enabled` first
    // would report a Google block as a user-disabled account, drop it out of
    // the blocked counter, and downgrade the toast from a warning.
    if (isIneligible(account)) state = 'ineligible'
    else if (isVerificationRequired(account)) state = 'verification'
    else if (!enabledOf(account)) state = 'disabled'
    else if (cooling.length > 0) state = 'rate-limited'
    return {
      key: accountKey(account, index),
      index,
      maskedEmail: email ? maskEmail(email) : undefined,
      state,
      coolingFamilies: cooling,
      cooldownUntil: cooling.reduce((latest, family) => {
        const until = resets[family] ?? 0
        return until > latest ? until : latest
      }, 0),
    }
  })
  const activeByFamily = ((): AccountPoolStatus['activeByFamily'] => {
    if (storage.version !== 4) return {}
    const v4 = storage as AccountStorageV4
    return { ...v4.activeIndexByFamily }
  })()
  return {
    total: accounts.length,
    ready: accounts.filter((account) => account.state === 'ready').length,
    cooling: accounts.filter((account) => account.state === 'rate-limited')
      .length,
    blocked: accounts.filter(
      (account) =>
        account.state === 'ineligible' || account.state === 'verification',
    ).length,
    disabled: accounts.filter((account) => account.state === 'disabled').length,
    accounts,
    activeByFamily,
  }
}

function countByKey(accounts: readonly AccountStatus[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const account of accounts) {
    counts.set(account.key, (counts.get(account.key) ?? 0) + 1)
  }
  return counts
}

export function diffAccountPoolStatus(
  previous: AccountPoolStatus | undefined,
  next: AccountPoolStatus,
): PoolChange[] {
  if (!previous) return []
  const changes: PoolChange[] = []
  // Match on the stable key, not the pool index: removing or inserting an
  // account renumbers every later entry, and an index-keyed diff then reports
  // the survivor as changed (or attributes one account's prior state to
  // another).
  const previousByKey = new Map(
    previous.accounts.map((account) => [account.key, account]),
  )
  // A key is only usable for attribution when it names exactly one account on
  // each side. Index-derived keys are positional and can change meaning across a
  // membership change; normalised-duplicate addresses make a key ambiguous.
  // Both cases are suppressed rather than guessed, so a blocked account is
  // reported only when we are sure which account moved.
  const previousCounts = countByKey(previous.accounts)
  const nextCounts = countByKey(next.accounts)
  for (const account of next.accounts) {
    if (!isStableAccountKey(account.key)) continue
    if (
      (previousCounts.get(account.key) ?? 0) > 1 ||
      (nextCounts.get(account.key) ?? 0) > 1
    ) {
      continue
    }
    const before = previousByKey.get(account.key)
    // An account with no counterpart is newly added. It has no prior state, so
    // there is no transition to report.
    if (!before) continue
    const id = displayAccountId(account)
    if (before.state === account.state) {
      if (account.state !== 'rate-limited') continue
      for (const family of account.coolingFamilies) {
        if (!before.coolingFamilies.includes(family)) {
          changes.push({ kind: 'rate-limited', account: id, family })
        }
      }
      continue
    }
    // Branch order mirrors the state precedence in `summarizeAccountPool`.
    // Testing the disabled/re-enabled pair first would swallow a Google block:
    // core disables an account as it applies the block, so the common
    // transition is `disabled -> ineligible`, which an earlier
    // `before === 'disabled'` test would report as "re-enabled".
    if (account.state === 'ineligible') {
      changes.push({ kind: 'ineligible', account: id })
    } else if (account.state === 'verification') {
      changes.push({ kind: 'verification', account: id })
    } else if (account.state === 'disabled') {
      changes.push({ kind: 'disabled', account: id })
    } else if (before.state === 'disabled') {
      changes.push({ kind: 're-enabled', account: id })
    } else if (account.state === 'rate-limited') {
      for (const family of account.coolingFamilies) {
        changes.push({ kind: 'rate-limited', account: id, family })
      }
    }
  }
  return changes
}

const STATE_GLYPH: Record<AccountState, string> = {
  ready: '*',
  'rate-limited': '~',
  ineligible: '!',
  verification: '?',
  disabled: '-',
}

const SIDEBAR_GLYPH: Record<AccountState, string> = {
  ready: '•',
  'rate-limited': '◐',
  ineligible: '✕',
  verification: '⚠',
  disabled: '⊝',
}

/**
 * Pure merge of cached quota aggregates into a summarized pool. Quota is
 * fetched out-of-band (network, cached in memory) and joined by the stable
 * account key, so a quota snapshot can never re-order or re-identify accounts.
 */
export function attachQuota(
  status: AccountPoolStatus,
  quotaByKey: ReadonlyMap<string, QuotaGroups>,
): AccountPoolStatus {
  if (quotaByKey.size === 0) return status
  return {
    ...status,
    accounts: status.accounts.map((account) => {
      const quota = quotaByKey.get(account.key)
      return quota ? { ...account, quota } : account
    }),
  }
}

/**
 * Format an ISO reset time as a compact duration until reset. Keeps the
 * finest useful unit: `45m`, `2h 15m`, and `2d 10h` once the wait crosses a
 * day (a raw `167h 40m` is unreadable in a narrow sidebar, and the minute
 * precision of a multi-day reset is noise).
 */
export function formatResetIn(
  resetTime: string | undefined,
  now: number,
): string | undefined {
  if (!resetTime) return undefined
  const timestamp = Date.parse(resetTime)
  if (!Number.isFinite(timestamp)) return undefined
  const ms = timestamp - now
  if (ms <= 0) return undefined
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`
}

/** Format a remaining cooldown timestamp as a compact duration (e.g. `45s`, `1m 20s`, `15m`). */
export function formatCooldown(until: number, now: number): string {
  const ms = Math.max(0, until - now)
  const totalSeconds = Math.ceil(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`
}

/**
 * Compact per-group quota fragments for one account, mirroring the OpenCode 1
 * adapter's hints: 100%-ready groups are noise and stay hidden, exhausted
 * groups with a future reset collapse into a reset duration, and anything
 * under 20% is flagged LOW. Groups without a usable fraction are skipped
 * (fail-open).
 */
export function formatQuotaParts(
  quota: QuotaGroups | undefined,
  now: number,
): string[] {
  if (!quota) return []
  const parts: string[] = []
  for (const [family, label] of [
    ['gemini', 'Gemini'],
    ['non-gemini', 'Non-Gemini'],
  ] as const) {
    const group = quota[family]
    const remaining = group?.remainingFraction
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
    const clamped = Math.max(0, Math.min(1, remaining))
    const percent = Math.round(clamped * 100)
    if (clamped <= 0) {
      const resetIn = formatResetIn(group?.resetTime, now)
      if (resetIn) parts.push(`${label} exhausted (resets ${resetIn})`)
      // No reset time: stale exhaustion reads as ready on Google's side.
      continue
    }
    if (percent >= 100) continue
    parts.push(
      clamped < 0.2 ? `${label} LOW ${percent}%` : `${label} ${percent}%`,
    )
  }
  return parts
}

export function formatAccountLine(
  account: AccountStatus,
  now: number,
  activeFamilies: readonly string[] = [],
): string {
  const id = displayAccountId(account)
  const glyph = STATE_GLYPH[account.state]
  const parts: string[] = []
  if (account.state === 'rate-limited') {
    const minutes = Math.max(
      1,
      Math.round((account.cooldownUntil - now) / 60_000),
    )
    parts.push(`COOLDOWN ${minutes}m (${account.coolingFamilies.join(',')})`)
  } else if (account.state === 'ineligible') {
    parts.push('INELIGIBLE')
  } else if (account.state === 'verification') {
    parts.push('VALIDATION REQUIRED')
  } else if (account.state === 'disabled') {
    parts.push('DISABLED')
  } else {
    parts.push('READY')
  }
  parts.push(...formatQuotaParts(account.quota, now))
  const active = activeFamilies.join('/')
  if (active) parts.push(`active: ${active}`)
  return `${glyph} ${id} ${parts.join(' · ')}`
}

// ============================================================================
// Sidebar block rendering — visual per-account rows for the OpenTUI sidebar
// ============================================================================

/** A colored text row for the sidebar block. */
export interface SidebarRow {
  readonly text: string
  /** OpenTUI foreground color (hex); undefined = terminal default. */
  readonly fg?: string
  /** Structured glyph for rich OpenTUI rendering (e.g. '•', '◐', '✕', '⊝') */
  readonly glyph?: string
  /** Foreground color for the glyph (semantic health color) */
  readonly glyphFg?: string
  /** Account label (masked email or id) */
  readonly label?: string
  /** State badge text (e.g. 'DISABLED', 'INELIGIBLE', or cooldown if no bars) */
  readonly badge?: string
  /** Color for state badge */
  readonly badgeFg?: string
}

const BAR_WIDTH = 10
const BAR_FILLED = '█'
const BAR_EMPTY = '░'
const GREEN = '#22c55e'
const YELLOW = '#eab308'
const RED = '#ef4444'
const ACTIVE_BLUE = '#38bdf8'

/**
 * Short gutter for a quota window, so the 5-hour and weekly rows stay
 * distinguishable at a glance. Unknown windows fall back to their raw name.
 */
const WINDOW_GUTTER: Record<string, string> = {
  '5h': '5h',
  weekly: '7d',
}

export function windowGutter(window: string): string {
  return WINDOW_GUTTER[window] ?? window
}

export function quotaBar(fraction: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  const filled = Math.round(clamped * width)
  return (
    BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(Math.max(0, width - filled))
  )
}

export function quotaBarColor(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  if (clamped >= 0.5) return GREEN
  if (clamped >= 0.2) return YELLOW
  return RED
}

export function accountStateColor(
  state: AccountState,
  isActive: boolean = false,
): string {
  switch (state) {
    case 'ready':
      return isActive ? ACTIVE_BLUE : GREEN
    case 'rate-limited':
      return '#fbbf24'
    case 'ineligible':
      return RED
    case 'verification':
      return '#facc15'
    case 'disabled':
      return '#64748b'
  }
}

type QuotaFamily = 'gemini' | 'non-gemini'

/** Cooldown keys that block the whole account rather than one quota family. */
const ACCOUNT_WIDE_COOLDOWNS: ReadonlySet<string> = new Set([
  'account',
  'auth-failure',
  'network-error',
  'project-error',
  'validation-required',
])

/** Fractions of every bar `sidebarRows` will draw, grouped by family. */
function quotaBarFractions(
  account: AccountStatus,
): Partial<Record<QuotaFamily, number[]>> {
  const result: Partial<Record<QuotaFamily, number[]>> = {}
  for (const family of ['gemini', 'non-gemini'] as const) {
    const group = account.quota?.[family]
    const windows = group?.windows
    if (windows && windows.length > 0) {
      result[family] = windows.map((entry) =>
        clampFraction(entry.remainingFraction),
      )
    } else if (
      typeof group?.remainingFraction === 'number' &&
      Number.isFinite(group.remainingFraction)
    ) {
      result[family] = [clampFraction(group.remainingFraction)]
    }
  }
  return result
}

function clampFraction(fraction: number): number {
  return Math.max(0, Math.min(1, fraction))
}

/** ` (↻ 2d 10h)` for a live reset, ` (exhausted)` for a stale zero, else ''. */
function resetSuffix(
  clamped: number,
  resetTime: string | undefined,
  now: number,
): string {
  const resetIn = formatResetIn(resetTime, now)
  if (resetIn) return ` (↻ ${resetIn})`
  return clamped <= 0 ? ' (exhausted)' : ''
}

/**
 * A blocked/disabled account keeps its cached quota visible for context, but a
 * healthy green bar would read as "usable". Mute the bar to the state color
 * unless the pool can actually dispatch to the account.
 */
function quotaBarTone(state: AccountState, clamped: number): string {
  if (state === 'ready' || state === 'rate-limited') {
    return quotaBarColor(clamped)
  }
  return accountStateColor(state, false)
}

function barRow(
  prefix: string,
  clamped: number,
  suffix: string,
  fg: string,
): SidebarRow {
  const percent = Math.round(clamped * 100)
  return {
    text: `${prefix} ${quotaBar(clamped)} ${String(percent).padStart(3)}%${suffix}`,
    fg,
  }
}

/**
 * Rows for one account's sidebar block: an identity line (with the active
 * marker and any non-ready state) followed by one colored bar line per
 * quota window. Antigravity exposes each pool as a 5-hour and a weekly window;
 * showing both — the earlier code collapsed to the most-constrained one — is
 * what makes the weekly column visible. The window gutter (`5h` / `7d`) labels
 * each bar so a percentage is never mistaken for the wrong window. Legacy
 * cached shapes with a single fraction render one unlabeled bar.
 *
 * Designed for a narrow sidebar — every row stays short instead of wrapping.
 * Non-ready states keep their word; a READY account shows no state word (the
 * bar is the information).
 */
export function sidebarRows(
  account: AccountStatus,
  now: number,
  activeFamilies: readonly string[] = [],
): SidebarRow[] {
  const fractions = quotaBarFractions(account)
  const isAccountWideCooldown = account.coolingFamilies.some((family) =>
    ACCOUNT_WIDE_COOLDOWNS.has(family),
  )
  // An exhausted bar already says why the account is limited and when it
  // resets. A cooldown with no exhausted bar (a short 429 backoff, capacity
  // errors, stale cached quota) has no other explanation on screen.
  const cooldownExplainedByBar = Object.values(fractions).some((values) =>
    values.some((value) => value <= 0),
  )
  const activeWithoutBars = (
    [
      ['gemini', 'G', activeFamilies.includes('gemini')],
      [
        'non-gemini',
        'C',
        activeFamilies.includes('claude') ||
          activeFamilies.includes('non-gemini'),
      ],
    ] as const
  )
    .filter(([family, , active]) => active && !fractions[family])
    .map(([, label]) => label)

  const glyph = SIDEBAR_GLYPH[account.state]
  const glyphFg = accountStateColor(account.state, false)
  const label = displayAccountId(account)

  let badge: string | undefined
  let badgeFg: string | undefined

  if (account.state === 'rate-limited') {
    if (isAccountWideCooldown || !cooldownExplainedByBar) {
      badge = `Cooldown ${formatCooldown(account.cooldownUntil, now)}`
      badgeFg = '#fbbf24'
    }
  } else if (account.state === 'ineligible') {
    badge = 'INELIGIBLE'
    badgeFg = '#ef4444'
  } else if (account.state === 'verification') {
    badge = 'VALIDATION REQUIRED'
    badgeFg = '#facc15'
  } else if (account.state === 'disabled') {
    badge = 'DISABLED'
    badgeFg = '#64748b'
  } else if (activeWithoutBars.length > 0) {
    // The `▸` marker lives on a bar row; a family with no bar still needs
    // to show that traffic is routed here.
    badge = `active: ${activeWithoutBars.join(', ')}`
    badgeFg = ACTIVE_BLUE
  }

  const identity = badge ? `${glyph} ${label} · ${badge}` : `${glyph} ${label}`

  const rows: SidebarRow[] = [
    {
      text: identity,
      fg: glyphFg,
      glyph,
      glyphFg,
      label,
      badge,
      badgeFg,
    },
  ]

  for (const [family, familyLabel] of [
    ['gemini', 'G'],
    ['non-gemini', 'C'],
  ] as const) {
    const isFamilyActive =
      family === 'gemini'
        ? activeFamilies.includes('gemini')
        : activeFamilies.includes('claude') ||
          activeFamilies.includes('non-gemini')

    const activeMarker = isFamilyActive ? '▸' : ' '

    const group = account.quota?.[family]
    const windows = group?.windows
    if (windows && windows.length > 0) {
      windows.forEach((entry, index) => {
        const clamped = clampFraction(entry.remainingFraction)
        const gutter = windowGutter(entry.window)
        // Align bars in a column: the family label rides the first window,
        // later windows indent under it by exactly one family column.
        // Active family gets '▸ G 5h', inactive gets '  G 5h', sub-window gets '    7d'
        const prefix =
          index === 0
            ? `${activeMarker} ${familyLabel} ${gutter}`
            : `    ${gutter}`
        rows.push(
          barRow(
            prefix,
            clamped,
            resetSuffix(clamped, entry.resetTime, now),
            quotaBarTone(account.state, clamped),
          ),
        )
      })
      continue
    }

    const remaining = group?.remainingFraction
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
    const clamped = clampFraction(remaining)
    rows.push(
      barRow(
        `${activeMarker} ${familyLabel}`,
        clamped,
        resetSuffix(clamped, group?.resetTime, now),
        quotaBarTone(account.state, clamped),
      ),
    )
  }

  return rows
}

/**
 * One-line pool summary for the prompt footer. Deliberately terse: the caller
 * has no session context, so there is no family to resolve an "active account"
 * suffix against — per-account detail belongs in the sidebar lines instead.
 */
export function formatPoolSummaryLine(status: AccountPoolStatus): string {
  const blocked = status.blocked > 0 ? ` · ${status.blocked} blocked` : ''
  const disabled = status.disabled > 0 ? ` · ${status.disabled} off` : ''
  return `AGY ${status.ready}/${status.total} ready${blocked}${disabled}`
}
