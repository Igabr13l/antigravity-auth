import { describe, expect, it } from 'bun:test'
import {
  accessTokenExpired,
  calculateTokenExpiry,
  formatRefreshParts,
  isOAuthAuth,
  parseRefreshParts,
} from './auth.ts'

describe('isOAuthAuth', () => {
  it('returns true for oauth type', () => {
    expect(isOAuthAuth({ type: 'oauth', access: 'tok' })).toBe(true)
  })

  it('returns false for non-oauth types', () => {
    expect(isOAuthAuth({ type: 'api-key' })).toBe(false)
    expect(isOAuthAuth({ type: 'none' })).toBe(false)
    expect(isOAuthAuth({})).toBe(false)
    expect(isOAuthAuth(null)).toBe(false)
    expect(isOAuthAuth(undefined)).toBe(false)
    expect(isOAuthAuth('oauth')).toBe(false)
  })
})

describe('parseRefreshParts', () => {
  it('parses a full packed string', () => {
    const result = parseRefreshParts('token123|proj_abc|managed_proj')
    expect(result.refreshToken).toBe('token123')
    expect(result.projectId).toBe('proj_abc')
    expect(result.managedProjectId).toBe('managed_proj')
  })

  it('handles token-only format', () => {
    const result = parseRefreshParts('token123')
    expect(result.refreshToken).toBe('token123')
    expect(result.projectId).toBeUndefined()
    expect(result.managedProjectId).toBeUndefined()
  })

  it('handles token + projectId format', () => {
    const result = parseRefreshParts('token123|proj_abc')
    expect(result.refreshToken).toBe('token123')
    expect(result.projectId).toBe('proj_abc')
    expect(result.managedProjectId).toBeUndefined()
  })

  it('returns empty token for empty input', () => {
    const result = parseRefreshParts('')
    expect(result.refreshToken).toBe('')
    expect(result.projectId).toBeUndefined()
    expect(result.managedProjectId).toBeUndefined()
  })

  it('handles null/undefined gracefully', () => {
    const result = parseRefreshParts(null as unknown as string)
    expect(result.refreshToken).toBe('')
  })
})

describe('formatRefreshParts', () => {
  it('round-trips with parseRefreshParts', () => {
    const parts = { refreshToken: 'tok', projectId: 'p', managedProjectId: 'm' }
    const formatted = formatRefreshParts(parts)
    const parsed = parseRefreshParts(formatted)
    expect(parsed.refreshToken).toBe('tok')
    expect(parsed.projectId).toBe('p')
    expect(parsed.managedProjectId).toBe('m')
  })

  it('omits projectId segment when undefined', () => {
    const formatted = formatRefreshParts({ refreshToken: 'tok' })
    expect(formatted).toBe('tok|')
  })

  it('omits managedProjectId when undefined', () => {
    const formatted = formatRefreshParts({
      refreshToken: 'tok',
      projectId: 'p',
    })
    expect(formatted).toBe('tok|p')
  })
})

describe('accessTokenExpired', () => {
  it('returns true when expires is missing', () => {
    expect(accessTokenExpired({ type: 'oauth', access: 'tok' } as never)).toBe(
      true,
    )
  })

  it('returns true when access is missing', () => {
    expect(
      accessTokenExpired({
        type: 'oauth',
        expires: Date.now() + 300000,
      } as never),
    ).toBe(true)
  })

  it('returns false for a fresh token beyond 60s buffer', () => {
    expect(
      accessTokenExpired({
        type: 'oauth',
        access: 'tok',
        expires: Date.now() + 120000,
      } as never),
    ).toBe(false)
  })

  it('returns true for a token within the 60s buffer', () => {
    expect(
      accessTokenExpired({
        type: 'oauth',
        access: 'tok',
        expires: Date.now() + 30000,
      } as never),
    ).toBe(true)
  })

  it('returns true for an expired token', () => {
    expect(
      accessTokenExpired({
        type: 'oauth',
        access: 'tok',
        expires: Date.now() - 1000,
      } as never),
    ).toBe(true)
  })
})

describe('calculateTokenExpiry', () => {
  const now = Date.now()

  it('computes expiry from seconds duration', () => {
    expect(calculateTokenExpiry(now, 3600)).toBe(now + 3600 * 1000)
    expect(calculateTokenExpiry(now, 60)).toBe(now + 60000)
  })

  it('defaults to 3600s when expiresInSeconds is not a number', () => {
    expect(calculateTokenExpiry(now, undefined)).toBe(now + 3600 * 1000)
    expect(calculateTokenExpiry(now, '7200')).toBe(now + 3600 * 1000)
  })

  it('returns requestTimeMs for invalid values', () => {
    expect(calculateTokenExpiry(now, 0)).toBe(now)
    expect(calculateTokenExpiry(now, -100)).toBe(now)
    expect(calculateTokenExpiry(now, NaN)).toBe(now)
  })
})
