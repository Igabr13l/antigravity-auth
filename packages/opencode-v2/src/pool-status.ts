// Pure derivation of the shared account pool into TUI-displayable status.
//
// Redaction rule (mirrors core): account `label` may contain personal
// information and never crosses this boundary — accounts are identified by
// masked email, falling back to pool index.

import { createHash } from 'node:crypto'

import type {
  AccountStorageV4,
  AnyAccountStorage,
} from '@cortexkit/antigravity-auth-core'

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
  if (!email) return `#${index}`
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex')
  return `e:${digest.slice(0, 12)}`
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

export function diffAccountPoolStatus(
  previous: AccountPoolStatus | undefined,
  next: AccountPoolStatus,
): PoolChange[] {
  if (!previous) return []
  const changes: PoolChange[] = []
  // Match on the stable key, not the pool index: removing or inserting an
  // account renumbers every later entry, and an index-keyed diff then reports
  // the survivor as changed (or attributes one account's prior state to
  // another). Accounts with no email fall back to an index-derived key, so
  // they degrade to the old behaviour rather than to a wrong match.
  const previousByKey = new Map(
    previous.accounts.map((account) => [account.key, account]),
  )
  for (const account of next.accounts) {
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

export function formatAccountLine(account: AccountStatus, now: number): string {
  const id = displayAccountId(account)
  const glyph = STATE_GLYPH[account.state]
  if (account.state === 'rate-limited') {
    const minutes = Math.max(
      1,
      Math.round((account.cooldownUntil - now) / 60_000),
    )
    return `${glyph} ${id} COOLDOWN ${minutes}m (${account.coolingFamilies.join(',')})`
  }
  if (account.state === 'ineligible') return `${glyph} ${id} INELIGIBLE`
  if (account.state === 'verification')
    return `${glyph} ${id} VALIDATION REQUIRED`
  if (account.state === 'disabled') return `${glyph} ${id} DISABLED`
  return `${glyph} ${id} READY`
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
