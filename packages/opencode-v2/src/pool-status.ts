// Pure derivation of the shared account pool into TUI-displayable status.
//
// Redaction rule (mirrors core): account `label` may contain personal
// information and never crosses this boundary — accounts are identified by
// masked email, falling back to pool index.

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
  readonly index: number
  readonly maskedEmail: string | undefined
  readonly state: AccountState
  /** Families currently cooling down, e.g. `claude`, `gemini-antigravity`. */
  readonly coolingFamilies: readonly string[]
  /** Latest instant at which any family cooldown for this account ends. */
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

function displayId(account: AccountStatus): string {
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

function resetsOf(account: PoolAccount): Record<string, number | undefined> {
  const resets: Record<string, number | undefined> = {}
  if ('rateLimitResetTimes' in account && account.rateLimitResetTimes) {
    for (const [family, until] of Object.entries(account.rateLimitResetTimes)) {
      resets[family] = until
    }
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

export function summarizeAccountPool(
  storage: AnyAccountStorage,
  now: number,
): AccountPoolStatus {
  const accounts = storage.accounts.map((account, index): AccountStatus => {
    const resets = resetsOf(account)
    const cooling = cooldownFamilies(resets, now)
    let state: AccountState = 'ready'
    if (!enabledOf(account)) state = 'disabled'
    else if (isIneligible(account)) state = 'ineligible'
    else if (isVerificationRequired(account)) state = 'verification'
    else if (cooling.length > 0) state = 'rate-limited'
    return {
      index,
      maskedEmail: account.email ? maskEmail(account.email) : undefined,
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
  for (const account of next.accounts) {
    const before = previous.accounts.find(
      (candidate) => candidate.index === account.index,
    )
    if (!before) continue
    const id = displayId(account)
    if (before.state === account.state) {
      if (account.state !== 'rate-limited') continue
      for (const family of account.coolingFamilies) {
        if (!before.coolingFamilies.includes(family)) {
          changes.push({ kind: 'rate-limited', account: id, family })
        }
      }
      continue
    }
    if (account.state === 'disabled' && before.state !== 'disabled') {
      changes.push({ kind: 'disabled', account: id })
    } else if (before.state === 'disabled' && account.state !== 'disabled') {
      changes.push({ kind: 're-enabled', account: id })
    } else if (account.state === 'ineligible') {
      changes.push({ kind: 'ineligible', account: id })
    } else if (account.state === 'verification') {
      changes.push({ kind: 'verification', account: id })
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
  const id = displayId(account)
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

export function formatPoolSummaryLine(
  status: AccountPoolStatus,
  activeFamily?: 'claude' | 'gemini',
): string {
  const active =
    activeFamily && status.activeByFamily[activeFamily] !== undefined
      ? ` · ${activeFamily} #${status.activeByFamily[activeFamily]}`
      : ''
  const blocked = status.blocked > 0 ? ` · ${status.blocked} blocked` : ''
  const disabled = status.disabled > 0 ? ` · ${status.disabled} off` : ''
  return `AGY ${status.ready}/${status.total} ready${active}${blocked}${disabled}`
}
