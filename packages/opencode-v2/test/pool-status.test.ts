import { describe, expect, test } from 'bun:test'

import type { AccountStorageV4 } from '@cortexkit/antigravity-auth-core'

import {
  accountKey,
  accountStateColor,
  attachQuota,
  diffAccountPoolStatus,
  formatAccountLine,
  formatCooldown,
  formatPoolSummaryLine,
  formatQuotaParts,
  formatResetIn,
  maskEmail,
  quotaBar,
  quotaBarColor,
  sidebarRows,
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
  test('formats quota fragments per group', () => {
    expect(
      formatQuotaParts(
        { gemini: { remainingFraction: 0.78, modelCount: 3 } },
        NOW,
      ),
    ).toEqual(['Gemini 78%'])
    expect(
      formatQuotaParts(
        { 'non-gemini': { remainingFraction: 0.15, modelCount: 2 } },
        NOW,
      ),
    ).toEqual(['Non-Gemini LOW 15%'])
  })

  test('hides saturated groups and skips fractions that are missing', () => {
    expect(
      formatQuotaParts(
        {
          gemini: { remainingFraction: 1, modelCount: 3 },
          'non-gemini': { modelCount: 2 },
        },
        NOW,
      ),
    ).toEqual([])
  })

  test('collapses exhausted groups into their reset duration', () => {
    const reset = new Date(NOW + 2 * 60 * 60 * 1000).toISOString()
    expect(
      formatQuotaParts(
        { gemini: { remainingFraction: 0, resetTime: reset, modelCount: 3 } },
        NOW,
      ),
    ).toEqual(['Gemini exhausted (resets 2h)'])
    // Stale exhaustion (no future reset) reads as ready and stays hidden.
    expect(
      formatQuotaParts(
        { gemini: { remainingFraction: 0, modelCount: 3 } },
        NOW,
      ),
    ).toEqual([])
  })

  test('attachQuota joins aggregates by stable account key', () => {
    const status = summarizeAccountPool(
      pool([{ email: 'a@example.test' }, { email: 'b@example.test' }]),
      NOW,
    )
    const quotaByKey = new Map([
      [
        status.accounts[1]!.key,
        { gemini: { remainingFraction: 0.4, modelCount: 3 } },
      ],
    ])
    const attached = attachQuota(status, quotaByKey)
    expect(attached.accounts[0]!.quota).toBeUndefined()
    expect(attached.accounts[1]!.quota?.gemini?.remainingFraction).toBe(0.4)
    expect(attached.accounts[1]!.key).toBe(status.accounts[1]!.key)
  })

  test('renders quota and the active account marker on the account line', () => {
    const status = summarizeAccountPool(
      pool([
        { email: 'a@example.test' },
        { email: 'b@example.test', enabled: false },
      ]),
      NOW,
    )
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          {
            gemini: { remainingFraction: 0.78, modelCount: 3 },
            'non-gemini': { remainingFraction: 0.15, modelCount: 2 },
          },
        ],
      ]),
    )
    expect(formatAccountLine(withQuota.accounts[0]!, NOW, ['gemini'])).toBe(
      '* a***@example.test READY · Gemini 78% · Non-Gemini LOW 15% · active: gemini',
    )
    expect(formatAccountLine(withQuota.accounts[1]!, NOW)).toBe(
      '- b***@example.test DISABLED',
    )
  })
  test('draws quota bars clamped to the width', () => {
    expect(quotaBar(0.61)).toBe('██████░░░░')
    expect(quotaBar(0)).toBe('░░░░░░░░░░')
    expect(quotaBar(1)).toBe('██████████')
    expect(quotaBar(2)).toBe('██████████')
  })

  test('colors bars by remaining health', () => {
    expect(quotaBarColor(0.61)).toBe('#22c55e')
    expect(quotaBarColor(0.3)).toBe('#eab308')
    expect(quotaBarColor(0.05)).toBe('#ef4444')
  })

  test('formats cooldown durations compactly with exact seconds when under one minute', () => {
    expect(formatCooldown(NOW + 45_000, NOW)).toBe('45s')
    expect(formatCooldown(NOW + 90_000, NOW)).toBe('1m 30s')
    expect(formatCooldown(NOW + 120_000, NOW)).toBe('2m')
    expect(formatCooldown(NOW + 3_600_000 * 2 + 15 * 60_000, NOW)).toBe(
      '2h 15m',
    )
  })

  test('resolves account state colors', () => {
    expect(accountStateColor('ready', true)).toBe('#38bdf8')
    expect(accountStateColor('ready', false)).toBe('#22c55e')
    expect(accountStateColor('rate-limited', false)).toBe('#fbbf24')
    expect(accountStateColor('disabled', false)).toBe('#64748b')
    expect(accountStateColor('ineligible', false)).toBe('#ef4444')
  })

  test('sidebar rows: identity line with the active marker and colored bars', () => {
    const status = summarizeAccountPool(
      pool([
        { email: 'a@example.test' },
        { email: 'b@example.test', enabled: false },
      ]),
      NOW,
    )
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          {
            gemini: { remainingFraction: 0.61, modelCount: 3 },
            'non-gemini': { remainingFraction: 0.15, modelCount: 2 },
          },
        ],
      ]),
    )
    expect(
      sidebarRows(withQuota.accounts[0]!, NOW, ['claude', 'gemini']),
    ).toEqual([
      {
        text: '• a***@example.test',
        fg: '#22c55e',
        glyph: '•',
        glyphFg: '#22c55e',
        label: 'a***@example.test',
        badge: undefined,
        badgeFg: undefined,
      },
      { text: '▸ G ██████░░░░  61%', fg: '#22c55e' },
      { text: '▸ C ██░░░░░░░░  15%', fg: '#ef4444' },
    ])
    expect(sidebarRows(withQuota.accounts[1]!, NOW)).toEqual([
      {
        text: '⊝ b***@example.test · DISABLED',
        fg: '#64748b',
        glyph: '⊝',
        glyphFg: '#64748b',
        label: 'b***@example.test',
        badge: 'DISABLED',
        badgeFg: '#64748b',
      },
    ])
  })

  test('sidebar rows: shows reset time on partial quotas and exhausted groups', () => {
    const status = summarizeAccountPool(
      pool([
        { email: 'a@example.test', enabled: true },
        {
          email: 'b@example.test',
          enabled: true,
          coolingDownUntil: NOW + 45_000,
        },
      ]),
      NOW,
    )
    const reset = new Date(NOW + 59 * 60 * 60 * 1000).toISOString()
    const partialReset = new Date(
      NOW + 2 * 60 * 60 * 1000 + 15 * 60_000,
    ).toISOString()
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          {
            gemini: {
              remainingFraction: 0.61,
              resetTime: partialReset,
              modelCount: 3,
            },
            'non-gemini': { remainingFraction: 1, modelCount: 2 },
          },
        ],
        [
          status.accounts[1]!.key,
          { gemini: { remainingFraction: 0, resetTime: reset, modelCount: 3 } },
        ],
      ]),
    )
    expect(
      sidebarRows(withQuota.accounts[0]!, NOW, ['claude', 'gemini']),
    ).toEqual([
      {
        text: '• a***@example.test',
        fg: '#22c55e',
        glyph: '•',
        glyphFg: '#22c55e',
        label: 'a***@example.test',
        badge: undefined,
        badgeFg: undefined,
      },
      { text: '▸ G ██████░░░░  61% (↻ 2h 15m)', fg: '#22c55e' },
      { text: '▸ C ██████████ 100%', fg: '#22c55e' },
    ])
    expect(sidebarRows(withQuota.accounts[1]!, NOW)).toEqual([
      {
        text: '◐ b***@example.test · Cooldown 45s',
        fg: '#fbbf24',
        glyph: '◐',
        glyphFg: '#fbbf24',
        label: 'b***@example.test',
        badge: 'Cooldown 45s',
        badgeFg: '#fbbf24',
      },
      { text: '  G ░░░░░░░░░░   0% (↻ 2d 11h)', fg: '#ef4444' },
    ])
  })

  test('sidebar rows: renders one labeled bar per quota window', () => {
    // Antigravity exposes each pool as a 5-hour and a weekly window. The
    // sidebar previously collapsed to the most-constrained one, hiding the
    // weekly column entirely.
    const status = summarizeAccountPool(
      pool([{ email: 'a@example.test' }]),
      NOW,
    )
    const fiveHourReset = new Date(
      NOW + 4 * 3_600_000 + 41 * 60_000,
    ).toISOString()
    const weeklyReset = new Date(NOW + 58 * 3_600_000).toISOString()
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          {
            gemini: {
              remainingFraction: 0.59,
              resetTime: weeklyReset,
              modelCount: 3,
              windows: [
                {
                  window: '5h',
                  remainingFraction: 0.95,
                  resetTime: fiveHourReset,
                },
                {
                  window: 'weekly',
                  remainingFraction: 0.59,
                  resetTime: weeklyReset,
                },
              ],
            },
            'non-gemini': {
              remainingFraction: 0.95,
              resetTime: fiveHourReset,
              modelCount: 2,
              windows: [
                {
                  window: '5h',
                  remainingFraction: 0.95,
                  resetTime: fiveHourReset,
                },
                {
                  window: 'weekly',
                  remainingFraction: 1,
                  resetTime: weeklyReset,
                },
              ],
            },
          },
        ],
      ]),
    )
    expect(sidebarRows(withQuota.accounts[0]!, NOW)).toEqual([
      {
        text: '• a***@example.test',
        fg: '#22c55e',
        glyph: '•',
        glyphFg: '#22c55e',
        label: 'a***@example.test',
        badge: undefined,
        badgeFg: undefined,
      },
      { text: '  G 5h ██████████  95% (↻ 4h 41m)', fg: '#22c55e' },
      { text: '    7d ██████░░░░  59% (↻ 2d 10h)', fg: '#22c55e' },
      { text: '  C 5h ██████████  95% (↻ 4h 41m)', fg: '#22c55e' },
      { text: '    7d ██████████ 100% (↻ 2d 10h)', fg: '#22c55e' },
    ])
  })

  test('sidebar rows: mutes quota bars for a blocked or disabled account', () => {
    // A cached green bar on a disabled account would read as "usable"; the bar
    // takes the state color instead.
    const status = summarizeAccountPool(
      pool([{ email: 'a@example.test' }]),
      NOW,
    )
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          { gemini: { remainingFraction: 1, modelCount: 3 } },
        ],
      ]),
    )
    const disabled = { ...withQuota.accounts[0]!, state: 'disabled' as const }
    expect(sidebarRows(disabled, NOW)).toEqual([
      {
        text: '⊝ a***@example.test · DISABLED',
        fg: '#64748b',
        glyph: '⊝',
        glyphFg: '#64748b',
        label: 'a***@example.test',
        badge: 'DISABLED',
        badgeFg: '#64748b',
      },
      { text: '  G ██████████ 100%', fg: '#64748b' },
    ])
  })

  test('sidebar rows: per-family rate limit with quota omits redundant cooldown text and marks active family with ▸', () => {
    // When an account is rate-limited on Gemini but active on Claude:
    // 1. The identity row preserves the amber ◐ glyph and does NOT append
    //    a redundant '· Cooldown ...' that causes line wrapping, because the G bar
    //    already shows 0% and the reset time.
    // 2. The active family (Claude) receives '▸ C' while inactive (Gemini) gets '  G'.
    const status = summarizeAccountPool(
      pool([
        {
          email: 'i@solunika.com',
          enabled: true,
          rateLimitResetTimes: {
            'gemini-antigravity:gemini-3.8-flash-high': NOW + 47 * 3_600_000,
          },
        },
      ]),
      NOW,
    )
    const geminiReset = new Date(NOW + 47 * 3_600_000).toISOString()
    const claudeReset = new Date(NOW + 6 * 24 * 3_600_000).toISOString()
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          {
            gemini: {
              remainingFraction: 0,
              resetTime: geminiReset,
              modelCount: 1,
              windows: [
                {
                  window: 'weekly',
                  remainingFraction: 0,
                  resetTime: geminiReset,
                },
              ],
            },
            'non-gemini': {
              remainingFraction: 1,
              resetTime: claudeReset,
              modelCount: 1,
              windows: [
                {
                  window: 'weekly',
                  remainingFraction: 1,
                  resetTime: claudeReset,
                },
              ],
            },
          },
        ],
      ]),
    )

    const rows = sidebarRows(withQuota.accounts[0]!, NOW, ['claude'])
    expect(rows).toEqual([
      {
        text: '◐ i***@solunika.com',
        fg: '#fbbf24',
        glyph: '◐',
        glyphFg: '#fbbf24',
        label: 'i***@solunika.com',
        badge: undefined,
        badgeFg: undefined,
      },
      { text: '  G 7d ░░░░░░░░░░   0% (↻ 1d 23h)', fg: '#ef4444' },
      { text: '▸ C 7d ██████████ 100% (↻ 6d)', fg: '#22c55e' },
    ])
  })

  test('sidebar rows: keeps the cooldown text when no exhausted bar explains it', () => {
    // A short per-family 429 backoff while cached quota still reads 100%:
    // dropping the badge would leave an amber glyph with no explanation.
    const status = summarizeAccountPool(
      pool([
        {
          email: 'a@example.test',
          enabled: true,
          rateLimitResetTimes: { claude: NOW + 60_000 },
        },
      ]),
      NOW,
    )
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          { 'non-gemini': { remainingFraction: 1, modelCount: 1 } },
        ],
      ]),
    )
    const rows = sidebarRows(withQuota.accounts[0]!, NOW)
    expect(rows[0]?.badge).toBe('Cooldown 1m')
    expect(rows[0]?.text).toBe('◐ a***@example.test · Cooldown 1m')
  })

  test('sidebar rows: account-wide cooldown reasons always keep the badge', () => {
    const status = summarizeAccountPool(
      pool([
        {
          email: 'a@example.test',
          enabled: true,
          coolingDownUntil: NOW + 600_000,
          cooldownReason: 'auth-failure',
        },
      ]),
      NOW,
    )
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          { gemini: { remainingFraction: 0, modelCount: 1 } },
        ],
      ]),
    )
    expect(sidebarRows(withQuota.accounts[0]!, NOW)[0]?.badge).toBe(
      'Cooldown 10m',
    )
  })

  test('sidebar rows: an active family without a bar is still labelled', () => {
    const status = summarizeAccountPool(
      pool([{ email: 'a@example.test', enabled: true }]),
      NOW,
    )
    const withQuota = attachQuota(
      status,
      new Map([
        [
          status.accounts[0]!.key,
          { gemini: { remainingFraction: 0.5, modelCount: 1 } },
        ],
      ]),
    )
    const rows = sidebarRows(withQuota.accounts[0]!, NOW, ['claude', 'gemini'])
    expect(rows[0]?.badge).toBe('active: C')
    expect(rows[1]?.text.startsWith('▸ G')).toBe(true)
  })

  test('formats multi-day resets in days', () => {
    expect(
      formatResetIn(new Date(NOW + 59 * 3_600_000).toISOString(), NOW),
    ).toBe('2d 11h')
    expect(
      formatResetIn(
        new Date(NOW + 167 * 3_600_000 + 40 * 60_000).toISOString(),
        NOW,
      ),
    ).toBe('6d 23h')
    expect(
      formatResetIn(new Date(NOW + 7 * 24 * 3_600_000).toISOString(), NOW),
    ).toBe('7d')
  })
})
