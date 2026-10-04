import { describe, expect, test } from 'bun:test'

import type { AccountStorageV4 } from '@cortexkit/antigravity-auth-core'

import {
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
        { email: 'blocked@example.test', accountIneligible: true },
        { email: 'off@example.test', enabled: false },
      ]),
      NOW,
    )
    expect(status.total).toBe(4)
    expect(status.ready).toBe(1)
    expect(status.cooling).toBe(1)
    expect(status.blocked).toBe(1)
    expect(status.disabled).toBe(1)
    expect(status.accounts[1]?.state).toBe('rate-limited')
    expect(status.accounts[1]?.coolingFamilies).toEqual(['gemini-antigravity'])
    expect(status.accounts[1]?.maskedEmail).toBe('c***@example.test')
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
        {
          email: 'both@example.test',
          accountIneligible: true,
          rateLimitResetTimes: { claude: NOW + 60_000 },
        },
      ]),
      NOW,
    )
    expect(status.accounts[0]?.state).toBe('ineligible')
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
        { email: 'a@example.test', accountIneligible: true },
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

  test('produces no changes without a previous snapshot', () => {
    const after = summarizeAccountPool(pool([{ email: 'a@example.test' }]), NOW)
    expect(diffAccountPoolStatus(undefined, after)).toEqual([])
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
        { email: 'b@example.test', accountIneligible: true },
        { email: 'c@example.test', enabled: false },
      ]),
      NOW,
    )
    expect(formatPoolSummaryLine(status)).toBe(
      'AGY 1/3 ready · 1 blocked · 1 off',
    )
  })
})
