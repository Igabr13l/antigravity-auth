import { describe, expect, it } from 'bun:test'

import {
  formatPlanTier,
  getMinimumPlanForModel,
  isAccountEligibleForModel,
  isPlanAtLeast,
  normalizePlanTier,
  PLAN_TIER_RANK,
  resolveAccountPlanTier,
} from './plan-tier.ts'

describe('plan-tier', () => {
  describe('normalizePlanTier', () => {
    it('normalizes free tier variants', () => {
      expect(normalizePlanTier('free-tier')).toBe('free')
      expect(normalizePlanTier('free')).toBe('free')
      expect(normalizePlanTier('basic-tier')).toBe('free')
      expect(normalizePlanTier('starter-tier')).toBe('free')
      expect(normalizePlanTier('TIER_FREE')).toBe('free')
    })

    it('normalizes plus tier variants', () => {
      expect(normalizePlanTier('plus-tier')).toBe('plus')
      expect(normalizePlanTier('plus')).toBe('plus')
      expect(normalizePlanTier('g1-plus')).toBe('plus')
      expect(normalizePlanTier('gemini-plus-tier')).toBe('plus')
    })

    it('normalizes pro tier variants', () => {
      expect(normalizePlanTier('pro-tier')).toBe('pro')
      expect(normalizePlanTier('pro')).toBe('pro')
      expect(normalizePlanTier('standard-tier')).toBe('pro')
      expect(normalizePlanTier('enterprise-tier')).toBe('pro')
      expect(normalizePlanTier('g1-pro')).toBe('pro')
      expect(normalizePlanTier('premium')).toBe('pro')
    })

    it('normalizes ultra tier variants', () => {
      expect(normalizePlanTier('ultra-tier')).toBe('ultra')
      expect(normalizePlanTier('ultra')).toBe('ultra')
      expect(normalizePlanTier('g1-ultra')).toBe('ultra')
      expect(normalizePlanTier('gemini-ultra-tier')).toBe('ultra')
    })

    it('falls back to unknown for invalid or empty inputs', () => {
      expect(normalizePlanTier(undefined)).toBe('unknown')
      expect(normalizePlanTier(null)).toBe('unknown')
      expect(normalizePlanTier('')).toBe('unknown')
      expect(normalizePlanTier('unrecognized-custom-tier')).toBe('unknown')
    })
  })

  describe('resolveAccountPlanTier', () => {
    it('prefers paidTier over currentTier when paidTier is present', () => {
      const account = {
        capturedTierId: 'free-tier',
        capturedPaidTierId: 'pro-tier',
      }
      expect(resolveAccountPlanTier(account)).toBe('pro')
    })

    it('falls back to capturedTierId when capturedPaidTierId is absent or unknown', () => {
      expect(
        resolveAccountPlanTier({
          capturedTierId: 'free-tier',
        }),
      ).toBe('free')

      expect(
        resolveAccountPlanTier({
          capturedTierId: 'ultra-tier',
          capturedPaidTierId: 'custom-unknown',
        }),
      ).toBe('ultra')
    })

    it('returns unknown when account is undefined or lacks tier info', () => {
      expect(resolveAccountPlanTier(undefined)).toBe('unknown')
      expect(resolveAccountPlanTier(null)).toBe('unknown')
      expect(resolveAccountPlanTier({})).toBe('unknown')
    })
  })

  describe('formatPlanTier', () => {
    it('formats tiers to title case strings', () => {
      expect(formatPlanTier('free')).toBe('Free')
      expect(formatPlanTier('plus')).toBe('Plus')
      expect(formatPlanTier('pro')).toBe('Pro')
      expect(formatPlanTier('ultra')).toBe('Ultra')
      expect(formatPlanTier('unknown')).toBe('Unknown')
    })
  })

  describe('isPlanAtLeast and ranking', () => {
    it('ranks tiers in strict ascending order', () => {
      expect(PLAN_TIER_RANK.unknown).toBeLessThan(PLAN_TIER_RANK.free)
      expect(PLAN_TIER_RANK.free).toBeLessThan(PLAN_TIER_RANK.plus)
      expect(PLAN_TIER_RANK.plus).toBeLessThan(PLAN_TIER_RANK.pro)
      expect(PLAN_TIER_RANK.pro).toBeLessThan(PLAN_TIER_RANK.ultra)
    })

    it('evaluates plan satisfaction correctly', () => {
      expect(isPlanAtLeast('ultra', 'pro')).toBe(true)
      expect(isPlanAtLeast('pro', 'pro')).toBe(true)
      expect(isPlanAtLeast('pro', 'plus')).toBe(true)
      expect(isPlanAtLeast('plus', 'pro')).toBe(false)
      expect(isPlanAtLeast('free', 'plus')).toBe(false)
      expect(isPlanAtLeast('free', 'free')).toBe(true)
      expect(isPlanAtLeast('unknown', 'free')).toBe(true)
      expect(isPlanAtLeast('free', 'unknown')).toBe(true)
    })
  })

  describe('getMinimumPlanForModel and isAccountEligibleForModel', () => {
    it('maps models to their minimum required tier', () => {
      expect(getMinimumPlanForModel('antigravity-gemini-4-carbon')).toBe(
        'ultra',
      )
      expect(
        getMinimumPlanForModel('antigravity-claude-opus-5-5-thinking'),
      ).toBe('pro')
      expect(
        getMinimumPlanForModel('antigravity-claude-opus-4-6-thinking'),
      ).toBe('pro')
      expect(
        getMinimumPlanForModel('antigravity-claude-sonnet-5-5-thinking'),
      ).toBe('plus')
      expect(
        getMinimumPlanForModel('antigravity-claude-sonnet-4-6-thinking'),
      ).toBe('plus')
      expect(getMinimumPlanForModel('antigravity-gemini-4-argon')).toBe('plus')
      expect(getMinimumPlanForModel('antigravity-gpt-oss-120b-medium')).toBe(
        'plus',
      )
      expect(getMinimumPlanForModel('antigravity-gemini-3.8-flash')).toBe(
        'free',
      )
      expect(getMinimumPlanForModel('antigravity-gemini-3.1-pro')).toBe('free')
    })

    it('evaluates account eligibility for model', () => {
      const freeAccount = { capturedTierId: 'free-tier' }
      const plusAccount = { capturedTierId: 'plus-tier' }
      const proAccount = { capturedTierId: 'pro-tier' }
      const unknownAccount = {}

      // Free model
      expect(
        isAccountEligibleForModel(freeAccount, 'antigravity-gemini-3.8-flash'),
      ).toBe(true)

      // Plus model
      expect(
        isAccountEligibleForModel(
          freeAccount,
          'antigravity-claude-sonnet-4-6-thinking',
        ),
      ).toBe(false)
      expect(
        isAccountEligibleForModel(
          plusAccount,
          'antigravity-claude-sonnet-4-6-thinking',
        ),
      ).toBe(true)

      // Pro model
      expect(
        isAccountEligibleForModel(
          plusAccount,
          'antigravity-claude-opus-4-6-thinking',
        ),
      ).toBe(false)
      expect(
        isAccountEligibleForModel(
          proAccount,
          'antigravity-claude-opus-4-6-thinking',
        ),
      ).toBe(true)

      // Unknown account is eligible (fail-open)
      expect(
        isAccountEligibleForModel(
          unknownAccount,
          'antigravity-claude-opus-4-6-thinking',
        ),
      ).toBe(true)
    })
  })
})
