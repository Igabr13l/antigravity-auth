import { describe, expect, it } from 'bun:test'

import {
  addJitter,
  calculateBackoffMs,
  computeSoftQuotaCacheTtlMs,
  HealthScoreTracker,
  parseDurationStringToMs,
  parseGoogleRpcRetryDelay,
  parseRateLimitReason,
  randomDelay,
  selectHybridAccount,
  sortByLruWithHealth,
  TokenBucketTracker,
} from './rotation.ts'

describe('rotation primitives', () => {
  it('parses rate-limit reasons and calculates deterministic backoff', () => {
    expect(parseRateLimitReason(undefined, 'service overloaded', 503)).toBe(
      'MODEL_CAPACITY_EXHAUSTED',
    )
    expect(
      calculateBackoffMs('MODEL_CAPACITY_EXHAUSTED', 0, null, () => 0.5),
    ).toBe(45_000)
    expect(computeSoftQuotaCacheTtlMs('auto', 3)).toBe(600_000)
  })

  it('injects random values for jitter helpers', () => {
    expect(addJitter(1_000, 0.3, () => 0)).toBe(700)
    expect(randomDelay(100, 500, () => 0.5)).toBe(300)
  })

  it('recovers health and tokens with injected time', () => {
    let now = 0
    const health = new HealthScoreTracker(
      { initial: 70, failurePenalty: -20, recoveryRatePerHour: 10 },
      () => now,
    )
    health.recordFailure(0)
    expect(health.getScore(0)).toBe(50)
    now = 2 * 60 * 60 * 1_000
    expect(health.getScore(0)).toBe(70)

    now = 0
    const tokens = new TokenBucketTracker(
      { initialTokens: 10, maxTokens: 10, regenerationRatePerMinute: 2 },
      () => now,
    )
    tokens.consume(0, 10)
    expect(tokens.getTokens(0)).toBe(0)
    now = 5 * 60 * 1_000
    expect(tokens.getTokens(0)).toBe(10)
  })

  it('sorts LRU candidates and hybrid-selects deterministically', () => {
    const candidates = [
      {
        index: 0,
        lastUsed: 5_000,
        healthScore: 70,
        isRateLimited: false,
        isCoolingDown: false,
      },
      {
        index: 1,
        lastUsed: 1_000,
        healthScore: 80,
        isRateLimited: false,
        isCoolingDown: false,
      },
    ]
    expect(sortByLruWithHealth(candidates).map(({ index }) => index)).toEqual([
      1, 0,
    ])
    const tokens = new TokenBucketTracker({}, () => 10_000)
    expect(
      selectHybridAccount(candidates, tokens, null, 50, () => 10_000),
    ).toBe(1)
  })

  it('parses duration strings accurately', () => {
    expect(parseDurationStringToMs('3600s')).toBe(3_600_000)
    expect(parseDurationStringToMs('120.5s')).toBe(120_500)
    expect(parseDurationStringToMs('500ms')).toBe(500)
    expect(parseDurationStringToMs('10m')).toBe(600_000)
    expect(parseDurationStringToMs('2h')).toBe(7_200_000)
    expect(parseDurationStringToMs('1d')).toBe(86_400_000)
    expect(parseDurationStringToMs('1h30m')).toBe(5_400_000)
    expect(parseDurationStringToMs('58h13m57s')).toBe(209_637_000)
    expect(parseDurationStringToMs('')).toBeNull()
    expect(parseDurationStringToMs('invalid')).toBeNull()
    expect(parseDurationStringToMs('-5s')).toBeNull()
  })

  it('parses Google RPC RetryInfo and ErrorInfo retry delays', () => {
    // 1. RetryInfo
    const retryInfoPayload = {
      error: {
        code: 429,
        message: 'Resource exhausted',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '3600.026s',
          },
        ],
      },
    }
    expect(parseGoogleRpcRetryDelay(retryInfoPayload)).toBe(3_600_026)

    // 2. ErrorInfo with quotaResetDelay
    const errorInfoDelayPayload = {
      error: {
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            metadata: {
              quotaResetDelay: '45m',
            },
          },
        ],
      },
    }
    expect(parseGoogleRpcRetryDelay(errorInfoDelayPayload)).toBe(2_700_000)

    // 3. ErrorInfo with quotaResetTimeStamp
    const fixedNow = 1_000_000_000
    const targetIso = new Date(fixedNow + 120_000).toISOString()
    const errorInfoTimestampPayload = {
      error: {
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            metadata: {
              quotaResetTimeStamp: targetIso,
            },
          },
        ],
      },
    }
    expect(
      parseGoogleRpcRetryDelay(errorInfoTimestampPayload, () => fixedNow),
    ).toBe(120_000)

    // 4. RetryInfo takes precedence over ErrorInfo
    const combinedPayload = {
      error: {
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            metadata: { quotaResetDelay: '600s' },
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '10s',
          },
        ],
      },
    }
    expect(parseGoogleRpcRetryDelay(combinedPayload)).toBe(10_000)

    // 5. Empty or missing details
    expect(parseGoogleRpcRetryDelay(null)).toBeUndefined()
    expect(parseGoogleRpcRetryDelay({})).toBeUndefined()
    expect(
      parseGoogleRpcRetryDelay({ error: { message: 'no details' } }),
    ).toBeUndefined()
  })
})
