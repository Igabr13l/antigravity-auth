import { describe, expect, test } from 'bun:test'

import type { AccountStorageV4 } from '@cortexkit/antigravity-auth-core'

import {
  accountKey,
  diffAccountPoolStatus,
  formatAccountLine,
  formatPoolSummaryLine,
  maskEmail,
  summarizeAccountPool,
} from '../src/pool-status.ts'

const NOW = 1_000_000

function pool(accounts: Array<Record<string, unknown>>): AccountStorageV4 {
  return {
    version: 4,
    accounts: accounts.map((account) => ({
      refreshToken: 'refresh',
      addedAt: 1,
      lastUsed: 1,
      ...account,
    })) as AccountStorageV4['accounts'],
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
  }
}

/**
 * The on-disk shape core produces when Google blocks an account:
 * `markAccountIneligible()` / `requestVerification()` set the block flag and
 * then call `setAccountEnabled(index, false)`. A fixture that carries the flag
 * without `enabled: false` is a shape the pool file never actually has.
 */
function blocked(
  email: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { email, enabled: false, ...extra }
}

describe('maskEmail', () => {
  test('keeps the first local character and the domain', () => {
    expect(maskEmail('alice@example.test')).toBe('a***@example.test')
  })

  test('falls back to a fully masked id for malformed addresses', () => {
    expect(maskEmail('no-at-sign')).toBe('***')
  })
})

describe('summarizeAccountPool', () => {
  test('classifies ready, cooling, blocked, and disabled accounts', () => {
    const status = summarizeAccountPool(
      pool([
        { email: 'ready@example.test' },
        {
          email: 'cooling@example.test',
          rateLimitResetTimes: { 'gemini-antigravity': NOW + 120_000 },
        },
        { email: 'off@example.test', enabled: false },
        blocked('blocked@example.test', { accountIneligible: true }),
      ]),
      NOW,
    )
    expect(status.total).toBe(4)
    expect(status.ready).toBe(1)
    expect(status.cooling).toBe(1)
    expect(status.blocked).toBe(1)
    expect(status.disabled).toBe(1)
    expect(status.accounts[2]?.state).toBe('disabled')
    expect(status.accounts[3]?.state).toBe('ineligible')
    expect(status.accounts[1]?.state).toBe('rate-limited')
    expect(status.accounts[1]?.coolingFamilies).toEqual(['gemini-antigravity'])
    expect(status.accounts[1]?.maskedEmail).toBe('c***@example.test')
  })

  test('reports a Google block ahead of the enabled flag core set for it', () => {
    // Regression: checking `enabled` first classified the block as a plain
    // disabled account, which hid it from the blocked counter and downgraded
    // the toast to a non-warning "disabled".
    const status = summarizeAccountPool(
      pool([
        blocked('ineligible@example.test', { accountIneligible: true }),
        blocked('verify@example.test', { verificationRequired: true }),
      ]),
      NOW,
    )
    expect(status.accounts[0]?.state).toBe('ineligible')
    expect(status.accounts[1]?.state).toBe('verification')
    expect(status.blocked).toBe(2)
    expect(status.disabled).toBe(0)
  })

  test('surfaces an account-wide cooldown that has no rate-limit entry', () => {
    // core refuses to dispatch to an account inside `coolingDownUntil`
    // (auth failure, network error, project error, validation). Reporting it
    // as READY would contradict the router.
    const status = summarizeAccountPool(
      pool([
        {
          email: 'authfail@example.test',
          coolingDownUntil: NOW + 300_000,
          cooldownReason: 'auth-failure',
        },
        {
          email: 'expired@example.test',
          coolingDownUntil: NOW - 1,
          cooldownReason: 'network-error',
        },
      ]),
      NOW,
    )
    expect(status.accounts[0]?.state).toBe('rate-limited')
    expect(status.accounts[0]?.coolingFamilies).toEqual(['auth-failure'])
    expect(status.accounts[0]?.cooldownUntil).toBe(NOW + 300_000)
    expect(status.accounts[1]?.state).toBe('ready')
    expect(status.cooling).toBe(1)
  })

  test('keeps the longest cooldown when several sources overlap', () => {
    const status = summarizeAccountPool(
      pool([
        {
          email: 'both@example.test',
          rateLimitResetTimes: { claude: NOW + 60_000 },
          coolingDownUntil: NOW + 600_000,
          cooldownReason: 'project-error',
        },
      ]),
      NOW,
    )
    expect(status.accounts[0]?.cooldownUntil).toBe(NOW + 600_000)
    expect(status.accounts[0]?.coolingFamilies).toEqual([
      'claude',
      'project-error',
    ])
  })

  test('keys accounts independently of pool position', () => {
    const before = summarizeAccountPool(
      pool([{ email: 'a@example.test' }, { email: 'b@example.test' }]),
      NOW,
    )
    // `a` is removed, so `b` shifts from index 1 to index 0.
    const after = summarizeAccountPool(pool([{ email: 'b@example.test' }]), NOW)
    expect(before.accounts[0]?.key).not.toBe(before.accounts[1]?.key)
    expect(after.accounts[0]?.key).toBe(before.accounts[1]?.key)
    expect(after.accounts[0]?.index).toBe(0)
    expect(diffAccountPoolStatus(before, after)).toEqual([])
  })

  test('never leaks the raw address through the account key', () => {
    const status = summarizeAccountPool(
      pool([{ email: 'alice@example.test' }]),
      NOW,
    )
    const key = status.accounts[0]!.key
    expect(key).toMatch(/^e:[0-9a-f]{12}$/)
    expect(key).not.toContain('alice')
    expect(key).not.toContain('example.test')
    // The key is derived from the address rather than the refresh token, so a
    // bare token rotation must not change it.
    const [other] = pool([
      { email: 'ALICE@example.test', refreshToken: 'rotated' },
    ]).accounts
    expect(accountKey(other!, 0)).toBe(key)
  })

  test('falls back to an index key for an account with no email', () => {
    const status = summarizeAccountPool(pool([{}, {}]), NOW)
    expect(status.accounts[0]?.key).toBe('#0')
    expect(status.accounts[1]?.key).toBe('#1')
    expect(status.accounts[0]?.maskedEmail).toBeUndefined()
  })

  test('expires cooldowns in the past and keeps v4 family indexes', () => {
    const status = summarizeAccountPool(
      pool([
        {
          email: 'stale@example.test',
          rateLimitResetTimes: { claude: NOW - 1 },
        },
      ]),
      NOW,
    )
    expect(status.accounts[0]?.state).toBe('ready')
    expect(status.activeByFamily).toEqual({ claude: 0, gemini: 0 })
  })

  test('prefers ineligibility over cooldowns for the displayed state', () => {
    const status = summarizeAccountPool(
      pool([
        blocked('both@example.test', {
          accountIneligible: true,
          rateLimitResetTimes: { claude: NOW + 60_000 },
        }),
      ]),
      NOW,
    )
    expect(status.accounts[0]?.state).toBe('ineligible')
  })

  test('prefers a user disable over a cooldown', () => {
    const status = summarizeAccountPool(
      pool([
        {
          email: 'off-and-cooling@example.test',
          enabled: false,
          rateLimitResetTimes: { claude: NOW + 60_000 },
        },
      ]),
      NOW,
    )
    expect(status.accounts[0]?.state).toBe('disabled')
  })
})

describe('diffAccountPoolStatus', () => {
  test('reports new cooldowns per family without duplicating known ones', () => {
    const before = summarizeAccountPool(
      pool([
        {
          email: 'a@example.test',
          rateLimitResetTimes: { claude: NOW + 60_000 },
        },
      ]),
      NOW,
    )
    const after = summarizeAccountPool(
      pool([
        {
          email: 'a@example.test',
          rateLimitResetTimes: {
            claude: NOW + 60_000,
            'gemini-antigravity': NOW + 120_000,
          },
        },
      ]),
      NOW,
    )
    expect(diffAccountPoolStatus(before, after)).toEqual([
      {
        kind: 'rate-limited',
        account: 'a***@example.test',
        family: 'gemini-antigravity',
      },
    ])
  })

  test('reports ineligible, disabled, and re-enabled transitions', () => {
    const before = summarizeAccountPool(
      pool([{ email: 'a@example.test' }, { email: 'b@example.test' }]),
      NOW,
    )
    const after = summarizeAccountPool(
      pool([
        blocked('a@example.test', { accountIneligible: true }),
        { email: 'b@example.test', enabled: false },
      ]),
      NOW,
    )
    const changes = diffAccountPoolStatus(before, after)
    expect(changes).toContainEqual({
      kind: 'ineligible',
      account: 'a***@example.test',
    })
    expect(changes).toContainEqual({
      kind: 'disabled',
      account: 'b***@example.test',
    })
  })

  test('reports a Google block applied to an already-disabled account', () => {
    const before = summarizeAccountPool(
      pool([{ email: 'a@example.test', enabled: false }]),
      NOW,
    )
    const after = summarizeAccountPool(
      pool([blocked('a@example.test', { accountIneligible: true })]),
      NOW,
    )
    expect(diffAccountPoolStatus(before, after)).toEqual([
      { kind: 'ineligible', account: 'a***@example.test' },
    ])
  })

  test('produces no changes without a previous snapshot', () => {
    const after = summarizeAccountPool(pool([{ email: 'a@example.test' }]), NOW)
    expect(diffAccountPoolStatus(undefined, after)).toEqual([])
  })

  test('suppresses transitions for positionally-keyed accounts', () => {
    // Address-less accounts key by index, which shifts with membership; a diff
    // must not attribute the removed account's state to whichever account
    // inherited its position.
    const before = summarizeAccountPool(pool([{}, { enabled: false }]), NOW)
    const after = summarizeAccountPool(pool([{ enabled: false }]), NOW)
    expect(after.accounts[0]?.key).toBe('#0')
    expect(diffAccountPoolStatus(before, after)).toEqual([])
  })

  test('suppresses transitions when two accounts share a normalised address', () => {
    // `User@` and `user@` are distinct to core (case-sensitive dedup) but
    // normalise to the same key, so neither transition can be attributed.
    const before = summarizeAccountPool(
      pool([{ email: 'User@example.test' }, { email: 'user@example.test' }]),
      NOW,
    )
    const after = summarizeAccountPool(
      pool([
        { email: 'User@example.test', enabled: false },
        { email: 'user@example.test' },
      ]),
      NOW,
    )
    expect(before.accounts[0]?.key).toBe(before.accounts[1]?.key)
    expect(diffAccountPoolStatus(before, after)).toEqual([])
  })
})

describe('formatting', () => {
  test('renders cooldown lines with rounded minutes', () => {
    const status = summarizeAccountPool(
      pool([
        {
          email: 'a@example.test',
          rateLimitResetTimes: { claude: NOW + 90_000 },
        },
      ]),
      NOW,
    )
    expect(formatAccountLine(status.accounts[0]!, NOW)).toBe(
      '~ a***@example.test COOLDOWN 2m (claude)',
    )
  })

  test('renders the summary line with blocked and disabled counters', () => {
    const status = summarizeAccountPool(
      pool([
        { email: 'a@example.test' },
        blocked('b@example.test', { accountIneligible: true }),
        { email: 'c@example.test', enabled: false },
      ]),
      NOW,
    )
    expect(formatPoolSummaryLine(status)).toBe(
      'AGY 1/3 ready · 1 blocked · 1 off',
    )
  })

  test('renders a blocked account as blocked, not as disabled', () => {
    const status = summarizeAccountPool(
      pool([blocked('b@example.test', { accountIneligible: true })]),
      NOW,
    )
    expect(formatAccountLine(status.accounts[0]!, NOW)).toBe(
      '! b***@example.test INELIGIBLE',
    )
    expect(formatPoolSummaryLine(status)).toBe('AGY 0/1 ready · 1 blocked')
  })

  test('renders an account-wide cooldown with its reason', () => {
    const status = summarizeAccountPool(
      pool([
        {
          email: 'a@example.test',
          coolingDownUntil: NOW + 120_000,
          cooldownReason: 'auth-failure',
        },
      ]),
      NOW,
    )
    expect(formatAccountLine(status.accounts[0]!, NOW)).toBe(
      '~ a***@example.test COOLDOWN 2m (auth-failure)',
    )
  })
})
