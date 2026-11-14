import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SessionHttpRequest } from '@opencode-ai/plugin/promise/session'

import plugin, {
  createOpenCodeV2AntigravityPlugin,
  endpointOwnsAccountQuota,
  parseResetDelayMs,
  upsertOAuthAccount,
} from '../src/plugin.ts'

function successResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'title' }] },
            finishReason: 'STOP',
          },
        ],
      },
    })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('opencode-v2-antigravity-auth plugin entry', () => {
  test('exports the plugin contract shape', () => {
    expect(plugin).toBeTypeOf('object')
    expect(plugin.id).toBe('cortexkit.antigravity-auth')
    expect(plugin.setup).toBeTypeOf('function')
  })

  test('stores the bare OAuth refresh token while preserving account identity state', () => {
    const result = upsertOAuthAccount(
      {
        version: 4,
        accounts: [
          {
            email: 'account@example.test',
            refreshToken: 'old-refresh',
            projectId: 'old-project',
            addedAt: 1,
            lastUsed: 2,
            enabled: false,
            rateLimitResetTimes: {},
            accountIneligible: true,
            accountIneligibleReason: 'ACCOUNT_INELIGIBLE',
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      },
      {
        type: 'success',
        refresh: 'new-refresh|new-project|managed-project',
        access: 'new-access',
        expires: 100,
        email: 'account@example.test',
        projectId: 'new-project',
      },
      50,
    )

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      refreshToken: 'new-refresh',
      projectId: 'new-project',
      managedProjectId: 'managed-project',
      addedAt: 1,
      lastUsed: 50,
      enabled: true,
      accountIneligible: false,
      verificationRequired: false,
    })
    expect(result.accounts[0]?.accountIneligibleReason).toBeUndefined()
    expect(result.accounts[0]?.verificationRequiredReason).toBeUndefined()
    expect(result.activeIndexByFamily).toEqual({ claude: 0, gemini: 0 })
  })

  test('rejects OAuth completion when account persistence fails', async () => {
    type OAuthMethodDefinition = {
      authorize: () => Promise<{ callback: Promise<unknown> }>
    }
    let oauthMethod: OAuthMethodDefinition | undefined
    const adapter = createOpenCodeV2AntigravityPlugin({
      authorizeAntigravity: async () => ({
        url: 'https://accounts.example/authorize?state=oauth-state',
        verifier: 'oauth-verifier',
        projectId: '',
      }),
      waitForAntigravityCode: async (state) => {
        expect(state).toBe('oauth-state')
        return 'oauth-code'
      },
      exchangeAntigravity: async () => ({
        type: 'success',
        refresh: 'oauth-refresh|oauth-project',
        access: 'oauth-access',
        expires: Date.now() + 60_000,
        projectId: 'oauth-project',
      }),
      mutateAccountStorage: async () => {
        throw new Error('disk write failed')
      },
    })
    const registration = { dispose: async () => {} }
    const cleanup = await adapter.setup({
      session: {
        hook: async () => registration,
      },
      integration: {
        transform: async (transform: unknown) => {
          ;(
            transform as (draft: {
              method: {
                update: (definition: OAuthMethodDefinition) => void
              }
            }) => void
          )({
            method: {
              update: (definition) => {
                oauthMethod = definition
              },
            },
          })
          return registration
        },
      },
    } as never)

    try {
      expect(oauthMethod).toBeDefined()
      const authorization = await oauthMethod!.authorize()
      await expect(authorization.callback).rejects.toThrow('disk write failed')
    } finally {
      if (cleanup) await cleanup()
    }
  })

  test('routes the host title model through a supported Antigravity model', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'antigravity-accounts.json'),
      `${JSON.stringify({
        version: 4,
        accounts: [
          {
            refreshToken: 'title-refresh',
            projectId: 'title-project',
            addedAt: 1,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      })}\n`,
    )

    let httpRequestHook:
      | ((event: SessionHttpRequest) => Promise<void>)
      | undefined
    let routedModel: string | undefined
    const adapter = createOpenCodeV2AntigravityPlugin({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: 'title-access',
        expires: Date.now() + 60_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'title-project',
        effectiveProjectId: 'title-project',
      }),
      send: async ({ envelope }) => {
        routedModel = envelope.model
        return successResponse()
      },
    })
    const registration = { dispose: async () => {} }
    const cleanup = await adapter.setup({
      session: {
        hook: async (name: string, callback: unknown) => {
          if (name === 'http.request') {
            httpRequestHook = callback as (
              event: SessionHttpRequest,
            ) => Promise<void>
          }
          return registration
        },
      },
      integration: {
        transform: async () => registration,
      },
    } as never)

    try {
      const event = {
        sessionID: 'title-session',
        agent: 'title-agent',
        model: {
          providerID: 'google',
          id: 'gemini-3.5-flash-lite',
        },
        kind: 'title',
        request: new Request(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'Create title' }] }],
            }),
          },
        ),
      }
      expect(httpRequestHook).toBeTypeOf('function')
      await httpRequestHook!(event as never)
      expect(new URL(event.request.url).hostname).toBe('127.0.0.1')
      const response = await fetch(event.request)
      expect(response.ok).toBe(true)
      expect(await response.text()).toContain('title')
      expect(routedModel).toBe('gemini-3.5-flash-extra-low')
    } finally {
      if (cleanup) await cleanup()
    }
  })

  test('fails fast on a 400 instead of rotating through every account', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
    mkdirSync(configDir, { recursive: true })
    const account = (name: string) => ({
      refreshToken: `${name}-refresh`,
      projectId: `${name}-project`,
      addedAt: 1,
      lastUsed: 0,
      enabled: true,
      rateLimitResetTimes: {},
    })
    writeFileSync(
      join(configDir, 'antigravity-accounts.json'),
      `${JSON.stringify({
        version: 4,
        accounts: [account('a'), account('b')],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      })}\n`,
    )

    let httpRequestHook:
      | ((event: SessionHttpRequest) => Promise<void>)
      | undefined
    let sends = 0
    const adapter = createOpenCodeV2AntigravityPlugin({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: `access-${refresh}`,
        expires: Date.now() + 60_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        projectId: 'project',
        effectiveProjectId: 'project',
      }),
      send: async () => {
        sends += 1
        return new Response(
          JSON.stringify({
            error: {
              status: 'INVALID_ARGUMENT',
              message: 'Invalid `signature` in `thinking` block',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    const registration = { dispose: async () => {} }
    const cleanup = await adapter.setup({
      session: {
        hook: async (name: string, callback: unknown) => {
          if (name === 'http.request') {
            httpRequestHook = callback as (
              event: SessionHttpRequest,
            ) => Promise<void>
          }
          return registration
        },
      },
      integration: { transform: async () => registration },
    } as never)

    try {
      const event = {
        sessionID: 'bad-request-session',
        agent: 'build',
        model: { providerID: 'google', id: 'gemini-3.8-flash' },
        kind: 'chat',
        request: new Request(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            }),
          },
        ),
      }
      await httpRequestHook!(event as never)
      const response = await fetch(event.request)
      const body = await response.text()
      // The payload, not the account, is at fault: one send, and the host sees
      // the real 400 (with the upstream detail) instead of a generic 502.
      expect(sends).toBe(1)
      expect(response.status).toBe(400)
      expect(body).toContain('INVALID_ARGUMENT')
      expect(body).toContain('Invalid `signature` in `thinking` block')
    } finally {
      if (cleanup) await cleanup()
    }
  })
})

describe('parseResetDelayMs', () => {
  test('reads the reset window out of an exhausted-quota message', () => {
    expect(
      parseResetDelayMs(
        'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 58h13m57s.',
      ),
    ).toBe(58 * 3_600_000 + 13 * 60_000 + 57_000)
    expect(parseResetDelayMs('Resets in 2d 3h.')).toBe(
      2 * 86_400_000 + 3 * 3_600_000,
    )
    expect(parseResetDelayMs('resets in 45m')).toBe(45 * 60_000)
  })

  test('reads millisecond windows instead of mistaking them for minutes', () => {
    expect(parseResetDelayMs('Resets in 500ms.')).toBe(500)
    expect(parseResetDelayMs('Resets in 1m 30s 250ms')).toBe(90_250)
  })

  test('returns undefined when the message carries no reset window', () => {
    expect(
      parseResetDelayMs('Resource has been exhausted (e.g. check quota).'),
    ).toBeUndefined()
    expect(parseResetDelayMs('')).toBeUndefined()
    expect(parseResetDelayMs(undefined)).toBeUndefined()
  })
})

describe('endpointOwnsAccountQuota', () => {
  test('treats the daily Antigravity host as the account quota owner', () => {
    expect(
      endpointOwnsAccountQuota('https://daily-cloudcode-pa.googleapis.com'),
    ).toBe(true)
  })

  test('treats the production Gemini CLI host as a foreign pool', () => {
    expect(
      endpointOwnsAccountQuota('https://cloudcode-pa.googleapis.com'),
    ).toBe(false)
  })

  test('treats unknown hosts as account quota owners', () => {
    expect(endpointOwnsAccountQuota('https://example.test')).toBe(true)
  })
})

describe('plan tier capture and capacity fallback routing', () => {
  test('captures and persists plan tier via ensureProjectContext and loadManagedProject backfill, then routes Opus to Pro account', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
    mkdirSync(configDir, { recursive: true })
    const accountsPath = join(configDir, 'antigravity-accounts.json')
    writeFileSync(
      accountsPath,
      JSON.stringify({
        version: 4,
        accounts: [
          {
            email: 'free@example.com',
            refreshToken: 'refresh-free',
            managedProjectId: 'proj-free',
            accessToken: 'access-free',
            expiresAt: Date.now() + 3_600_000,
            addedAt: 1,
            lastUsed: 2,
          },
          {
            email: 'pro@example.com',
            refreshToken: 'refresh-pro',
            managedProjectId: 'proj-pro',
            accessToken: 'access-pro',
            expiresAt: Date.now() + 3_600_000,
            addedAt: 2,
            lastUsed: 1,
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      }),
    )

    const usedTokens: string[] = []
    let httpRequestHook:
      | ((event: SessionHttpRequest) => Promise<void>)
      | undefined
    const registration = { dispose: async () => undefined }
    const adapter = createOpenCodeV2AntigravityPlugin({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh.replace('refresh-', 'access-'),
        expires: Date.now() + 3_600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        effectiveProjectId:
          auth.access === 'access-free' ? 'proj-free' : 'proj-pro',
      }),
      loadManagedProject: async (accessToken) =>
        accessToken === 'access-free'
          ? { currentTier: { id: 'free-tier' } }
          : {
              currentTier: { id: 'free-tier' },
              paidTier: { id: 'g1-pro-tier' },
            },
      send: async ({ auth }) => {
        usedTokens.push(auth.access ?? '')
        return successResponse()
      },
    })

    const cleanup = await adapter.setup({
      session: {
        hook: async (name: string, callback: unknown) => {
          if (name === 'http.request') {
            httpRequestHook = callback as (
              event: SessionHttpRequest,
            ) => Promise<void>
          }
          return registration
        },
      },
      integration: { transform: async () => registration },
    } as never)

    try {
      const makeEvent = (modelId: string, sessionID: string) => ({
        sessionID,
        agent: 'build',
        model: { providerID: 'google', id: modelId },
        kind: 'chat',
        request: new Request(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            }),
          },
        ),
      })

      // Request 1 uses account 0 for free Flash -> backfills free-tier
      const flashEvent = makeEvent('gemini-3.8-flash', 'tier-session-1')
      await httpRequestHook!(flashEvent as never)
      const flashResponse = await fetch(flashEvent.request)
      expect(flashResponse.status).toBe(200)

      // Next request wants Opus: account 0 is now known free-tier, while
      // account 1 is unknown/eligible so account 1 gets selected and backfills g1-pro-tier!
      const opusEvent = makeEvent('claude-opus-5-5-thinking', 'tier-session-2')
      await httpRequestHook!(opusEvent as never)
      const opusResponse = await fetch(opusEvent.request)
      expect(opusResponse.status).toBe(200)
      expect(usedTokens).toEqual(['access-free', 'access-pro'])
    } finally {
      if (cleanup) await cleanup()
    }

    const persisted = JSON.parse(readFileSync(accountsPath, 'utf8'))
    expect(persisted.accounts[0].capturedTierId).toBe('free-tier')
    expect(persisted.accounts[0].capturedTierSchemaVersion).toBe(1)
    expect(persisted.accounts[1].capturedTierId).toBe('free-tier')
    expect(persisted.accounts[1].capturedPaidTierId).toBe('g1-pro-tier')
    expect(persisted.accounts[1].capturedTierSchemaVersion).toBe(1)
  })

  test('marks MODEL_CAPACITY_EXHAUSTED when daily 503 capacity fallback fails on cloudcode-pa prod and persists cooldown', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
    mkdirSync(configDir, { recursive: true })
    const accountsPath = join(configDir, 'antigravity-accounts.json')
    writeFileSync(
      accountsPath,
      JSON.stringify({
        version: 4,
        accounts: [
          {
            email: 'one@example.com',
            refreshToken: 'refresh-one',
            projectId: 'proj-one',
            accessToken: 'access-one',
            expiresAt: Date.now() + 3_600_000,
            addedAt: 1,
            lastUsed: 2,
          },
          {
            email: 'two@example.com',
            refreshToken: 'refresh-two',
            projectId: 'proj-two',
            accessToken: 'access-two',
            expiresAt: Date.now() + 3_600_000,
            addedAt: 2,
            lastUsed: 1,
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      }),
    )

    const attempts: Array<{ token: string; endpoint: string }> = []
    let httpRequestHook:
      | ((event: SessionHttpRequest) => Promise<void>)
      | undefined
    const registration = { dispose: async () => undefined }
    const adapter = createOpenCodeV2AntigravityPlugin({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh.replace('refresh-', 'access-'),
        expires: Date.now() + 3_600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        effectiveProjectId: 'proj',
      }),
      send: async ({ auth, endpoint }) => {
        attempts.push({ token: auth.access ?? '', endpoint })
        if (auth.access === 'access-one') {
          if (endpoint === 'https://daily-cloudcode-pa.googleapis.com') {
            return new Response(
              JSON.stringify({
                error: {
                  message: 'No capacity available on daily',
                  details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }],
                },
              }),
              { status: 503 },
            )
          }
          // Non-owning prod endpoint returns 429 or 503: owning 503 MUST still cool account 0!
          return new Response(
            JSON.stringify({
              error: { message: 'Resource exhausted on prod' },
            }),
            { status: 429 },
          )
        }
        return successResponse()
      },
    })

    const cleanup = await adapter.setup({
      session: {
        hook: async (name: string, callback: unknown) => {
          if (name === 'http.request') {
            httpRequestHook = callback as (
              event: SessionHttpRequest,
            ) => Promise<void>
          }
          return registration
        },
      },
      integration: { transform: async () => registration },
    } as never)

    try {
      const event = {
        sessionID: 'capacity-mark-session',
        agent: 'build',
        model: {
          providerID: 'google',
          id: 'gemini-3.8-flash',
          variant: 'medium',
        },
        kind: 'chat',
        request: new Request(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            }),
          },
        ),
      }
      await httpRequestHook!(event as never)
      const response = await fetch(event.request)
      expect(response.status).toBe(200)
      expect(attempts).toEqual([
        {
          token: 'access-one',
          endpoint: 'https://daily-cloudcode-pa.googleapis.com',
        },
        {
          token: 'access-one',
          endpoint: 'https://cloudcode-pa.googleapis.com',
        },
        {
          token: 'access-two',
          endpoint: 'https://daily-cloudcode-pa.googleapis.com',
        },
      ])
    } finally {
      if (cleanup) await cleanup()
    }

    const persisted = JSON.parse(readFileSync(accountsPath, 'utf8'))
    const rateLimits = persisted.accounts[0].rateLimitResetTimes ?? {}
    expect(Object.keys(rateLimits).length).toBeGreaterThan(0)
  })

  test('skips cloudcode-pa prod fallback on 503 capacity failure for Antigravity-only models like Claude Opus and Argon', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
    mkdirSync(configDir, { recursive: true })
    const accountsPath = join(configDir, 'antigravity-accounts.json')
    writeFileSync(
      accountsPath,
      JSON.stringify({
        version: 4,
        accounts: [
          {
            email: 'one@example.com',
            refreshToken: 'refresh-one',
            projectId: 'proj-one',
            capturedTierId: 'pro-tier',
            accessToken: 'access-one',
            expiresAt: Date.now() + 3_600_000,
            addedAt: 1,
            lastUsed: 2,
          },
          {
            email: 'two@example.com',
            refreshToken: 'refresh-two',
            projectId: 'proj-two',
            capturedTierId: 'pro-tier',
            accessToken: 'access-two',
            expiresAt: Date.now() + 3_600_000,
            addedAt: 2,
            lastUsed: 1,
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      }),
    )

    const attempts: Array<{ token: string; endpoint: string }> = []
    let httpRequestHook:
      | ((event: SessionHttpRequest) => Promise<void>)
      | undefined
    const registration = { dispose: async () => undefined }
    const adapter = createOpenCodeV2AntigravityPlugin({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: refresh.replace('refresh-', 'access-'),
        expires: Date.now() + 3_600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        effectiveProjectId: 'proj',
      }),
      send: async ({ auth, endpoint }) => {
        attempts.push({ token: auth.access ?? '', endpoint })
        if (auth.access === 'access-one') {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Model capacity exhausted',
                details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }],
              },
            }),
            { status: 503 },
          )
        }
        return successResponse()
      },
    })

    const cleanup = await adapter.setup({
      session: {
        hook: async (name: string, callback: unknown) => {
          if (name === 'http.request') {
            httpRequestHook = callback as (
              event: SessionHttpRequest,
            ) => Promise<void>
          }
          return registration
        },
      },
      integration: { transform: async () => registration },
    } as never)

    try {
      const event = {
        sessionID: 'agy-only-503-session',
        agent: 'build',
        model: {
          providerID: 'google',
          id: 'gemini-4-argon',
          variant: 'high',
        },
        kind: 'chat',
        request: new Request(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            }),
          },
        ),
      }
      await httpRequestHook!(event as never)
      const response = await fetch(event.request)
      expect(response.status).toBe(200)
      expect(attempts).toEqual([
        {
          token: 'access-one',
          endpoint: 'https://daily-cloudcode-pa.googleapis.com',
        },
        {
          token: 'access-two',
          endpoint: 'https://daily-cloudcode-pa.googleapis.com',
        },
      ])
    } finally {
      if (cleanup) await cleanup()
    }
  })

  test('persists capturedTier via upsertOAuthAccount, refreshes stale tier (>24h), and preserves 503 prod fallback for gemini-3.8-flash', async () => {
    const seeded = upsertOAuthAccount(
      {
        version: 4,
        accounts: [],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      },
      {
        type: 'success',
        refresh: 'refresh-stale|proj-1',
        access: 'access-stale',
        expires: 999_999,
        email: 'user@example.com',
        projectId: 'proj-1',
      },
      100,
      { id: 'free-tier', paidId: 'plus-tier', capturedAt: 100 },
    )
    expect(seeded.accounts[0]?.capturedTierId).toBe('free-tier')
    expect(seeded.accounts[0]?.capturedPaidTierId).toBe('plus-tier')
    expect(seeded.accounts[0]?.capturedTierAt).toBe(100)

    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
    mkdirSync(configDir, { recursive: true })
    const accountsPath = join(configDir, 'antigravity-accounts.json')
    writeFileSync(
      accountsPath,
      `${JSON.stringify({
        version: 4,
        accounts: [
          {
            refreshToken: 'refresh-stale',
            email: 'user@example.com',
            projectId: 'proj-1',
            managedProjectId: 'proj-1',
            capturedTierId: 'free-tier',
            capturedPaidTierId: 'free-tier',
            capturedTierAt: 1,
            capturedTierSchemaVersion: 1,
            addedAt: 1,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { claude: 0, gemini: 0 },
      })}\n`,
    )

    let httpRequestHook:
      | ((event: SessionHttpRequest) => Promise<void>)
      | undefined
    const endpoints: string[] = []
    let loadCalls = 0
    const registration = { dispose: async () => undefined }
    const adapter = createOpenCodeV2AntigravityPlugin({
      refreshAntigravityToken: async (refresh) => ({
        refresh,
        access: 'access-stale',
        expires: Date.now() + 3_600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        effectiveProjectId: 'proj-1',
      }),
      loadManagedProject: async () => {
        loadCalls += 1
        return {
          currentTier: { id: 'free-tier' },
          paidTier: { id: 'g1-pro-tier' },
        }
      },
      send: async ({ endpoint }) => {
        endpoints.push(endpoint)
        if (endpoint === 'https://daily-cloudcode-pa.googleapis.com') {
          return new Response(
            JSON.stringify({
              error: { message: 'Temporary capacity limit on daily' },
            }),
            { status: 503 },
          )
        }
        return successResponse()
      },
    })

    const cleanup = await adapter.setup({
      session: {
        hook: async (name: string, callback: unknown) => {
          if (name === 'http.request') {
            httpRequestHook = callback as (
              event: SessionHttpRequest,
            ) => Promise<void>
          }
          return registration
        },
      },
      integration: { transform: async () => registration },
    } as never)

    try {
      const event = {
        sessionID: 'stale-tier-and-flash-fallback',
        agent: 'build',
        model: {
          providerID: 'google',
          id: 'gemini-3.8-flash',
          variant: 'medium',
        },
        kind: 'chat',
        request: new Request(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            }),
          },
        ),
      }
      await httpRequestHook!(event as never)
      const response = await fetch(event.request)
      expect(response.status).toBe(200)
      expect(loadCalls).toBe(1)
      expect(endpoints).toEqual([
        'https://daily-cloudcode-pa.googleapis.com',
        'https://cloudcode-pa.googleapis.com',
      ])
    } finally {
      if (cleanup) await cleanup()
    }

    const persisted = JSON.parse(readFileSync(accountsPath, 'utf8'))
    expect(persisted.accounts[0].capturedPaidTierId).toBe('g1-pro-tier')
    expect(persisted.accounts[0].capturedTierAt).toBeGreaterThan(1)
  })

  test('marks 403 TOS_VIOLATION account ineligible on disk and rotates to the next account', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error('OPENCODE_CONFIG_DIR is not set')
    mkdirSync(configDir, { recursive: true })
    const accountsPath = join(configDir, 'antigravity-accounts.json')
    writeFileSync(
      accountsPath,
      JSON.stringify(
        {
          version: 4,
          accounts: [
            {
              email: 'flagged@example.test',
              refreshToken: 'refresh-one',
              projectId: 'proj',
              managedProjectId: 'proj',
              capturedTierId: 'free-tier',
              capturedPaidTierId: 'g1-pro-tier',
              capturedTierAt: Date.now(),
              capturedTierSchemaVersion: 1,
              addedAt: 1,
              lastUsed: 2,
              enabled: true,
              rateLimitResetTimes: {},
            },
            {
              email: 'healthy@example.test',
              refreshToken: 'refresh-two',
              projectId: 'proj',
              managedProjectId: 'proj',
              capturedTierId: 'free-tier',
              capturedPaidTierId: 'g1-pro-tier',
              capturedTierAt: Date.now(),
              capturedTierSchemaVersion: 1,
              addedAt: 1,
              lastUsed: 1,
              enabled: true,
              rateLimitResetTimes: {},
            },
          ],
          activeIndex: 0,
          activeIndexByFamily: { claude: 0, gemini: 0 },
        },
        null,
        2,
      ),
    )

    let httpRequestHook: ((event: SessionHttpRequest) => Promise<void>) | null =
      null
    const attempts: string[] = []
    const registration = { dispose: async () => undefined }

    const adapter = createOpenCodeV2AntigravityPlugin({
      refreshAntigravityToken: async (refreshToken) => ({
        refresh: refreshToken,
        access:
          refreshToken === 'refresh-one' ? 'access-flagged' : 'access-healthy',
        expires: Date.now() + 3_600_000,
      }),
      ensureProjectContext: async (auth) => ({
        auth,
        effectiveProjectId: 'proj',
      }),
      send: async ({ auth }) => {
        attempts.push(auth.access ?? '')
        if (auth.access === 'access-flagged') {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message:
                  'This service has been disabled in this account for violation of Terms of Service.',
                details: [{ reason: 'TOS_VIOLATION' }],
              },
            }),
            { status: 403 },
          )
        }
        return successResponse()
      },
    })

    const cleanup = await adapter.setup({
      session: {
        hook: async (name: string, callback: unknown) => {
          if (name === 'http.request') {
            httpRequestHook = callback as (
              event: SessionHttpRequest,
            ) => Promise<void>
          }
          return registration
        },
      },
      integration: { transform: async () => registration },
    } as never)

    try {
      const event = {
        sessionID: 'tos-violation-rotation-session',
        agent: 'build',
        model: {
          providerID: 'google',
          id: 'gemini-4-argon',
          variant: 'high',
        },
        kind: 'chat',
        request: new Request(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            }),
          },
        ),
      }
      await httpRequestHook!(event as never)
      const response = await fetch(event.request)
      expect(response.status).toBe(200)
      expect(attempts).toEqual(['access-flagged', 'access-healthy'])
    } finally {
      if (cleanup) await cleanup()
    }

    const persisted = JSON.parse(readFileSync(accountsPath, 'utf8'))
    expect(persisted.accounts[0]).toMatchObject({
      enabled: false,
      accountIneligible: true,
      accountIneligibleReason: 'TOS_VIOLATION',
    })
    expect(persisted.accounts[1].enabled).toBe(true)
  })
})
