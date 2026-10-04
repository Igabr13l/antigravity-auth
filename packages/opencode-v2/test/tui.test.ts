import { describe, expect, test } from 'bun:test'

import type { AccountStorageV4 } from '@cortexkit/antigravity-auth-core'

import {
  createOpenCodeV2AntigravityTui,
  type OpenCodeV2TuiDependencyOverrides,
} from '../src/tui.tsx'

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

interface CapturedClaim {
  readonly target: string
  render: (input: unknown) => unknown
}

function stubContext() {
  const claims: CapturedClaim[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const layers: Array<{
    commands: Array<{ id: string; run: () => void; bind?: string }>
  }> = []
  let dialogOptions:
    | { title: string; options: Array<{ value: number }> }
    | undefined
  let dialogSelection: number | undefined
  const store = { status: undefined as unknown }

  const context = {
    storage: {
      memory: <Value extends object>(
        _key: string,
        options: { initial: Value },
      ) => {
        Object.assign(store, options.initial)
        const mutate = (mutation: (draft: Value) => void) => {
          mutation(store as Value)
        }
        return [store, mutate] as const
      },
    },
    ui: {
      slot: (claim: Record<string, unknown>) => {
        claims.push({
          target: String(claim.append),
          render: claim.render as (input: unknown) => unknown,
        })
        return () => {}
      },
      toast: {
        show: (options: { message: string; variant?: string }) => {
          toasts.push(options)
        },
      },
      dialog: {
        select: async <Value>(options: {
          title: string
          options: Array<{ value: Value }>
        }) => {
          dialogOptions = options as never
          return dialogSelection as Value
        },
      },
    },
    keymap: {
      layer: (
        input: () => {
          commands: Array<{ id: string; run: () => void; bind?: string }>
        },
      ) => {
        layers.push(input())
      },
    },
  }

  return {
    context,
    claims,
    toasts,
    layers,
    dialogOptions: () => dialogOptions,
    setDialogSelection: (value: number | undefined) => {
      dialogSelection = value
    },
    store: store as {
      status: import('../src/pool-status.ts').AccountPoolStatus | undefined
    },
  }
}

async function setupTui(overrides: OpenCodeV2TuiDependencyOverrides = {}) {
  const harness = stubContext()
  const plugin = createOpenCodeV2AntigravityTui({
    pollMs: 5,
    now: () => NOW,
    ...overrides,
  })
  const cleanup = await plugin.setup(harness.context as never)
  return { ...harness, cleanup }
}

describe('OpenCode 2 Antigravity TUI plugin', () => {
  test('exposes the plugin contract shape', () => {
    const plugin = createOpenCodeV2AntigravityTui()
    expect(plugin.id).toBe('cortexkit.antigravity-auth.tui')
    expect(plugin.setup).toBeTypeOf('function')
  })

  test('loads the pool, claims slots, and reflects account changes via toasts', async () => {
    let current = pool([{ email: 'a@example.test' }])
    const { claims, toasts, cleanup } = await setupTui({
      loadPool: async () => current,
    })

    expect(claims.map((claim) => claim.target)).toEqual([
      'prompt.footer.status',
      'sidebar.footer',
    ])
    expect(toasts).toEqual([])

    current = pool([
      { email: 'a@example.test', accountIneligible: true },
      { email: 'b@example.test' },
    ])
    await Bun.sleep(40)

    expect(toasts.length).toBeGreaterThan(0)
    expect(toasts[0]?.variant).toBe('warning')
    expect(toasts[0]?.message).toContain('a***@example.test')
    expect(toasts[0]?.message).toContain('INELIGIBLE')

    if (cleanup) await cleanup()
  })

  test('reports an unreadable pool without throwing', async () => {
    const { store, cleanup } = await setupTui({
      loadPool: async () => null,
    })
    expect(store.status).toBeUndefined()
    if (cleanup) await cleanup()
  })

  test('opens the accounts dialog and toggles the selected account', async () => {
    let current = pool([
      { email: 'a@example.test' },
      { email: 'b@example.test' },
    ])
    let mutations = 0
    const { claims, layers, dialogOptions, setDialogSelection, cleanup } =
      await setupTui({
        loadPool: async () => current,
        mutatePool: async (mutate) => {
          mutations += 1
          const next = mutate(current)
          if (next) current = next
          return current
        },
      })

    const summaryClaim = claims.find(
      (claim) => claim.target === 'prompt.footer.status',
    )
    expect(summaryClaim).toBeDefined()
    summaryClaim!.render({})
    expect(layers.length).toBe(1)
    const command = layers[0]?.commands.find(
      (candidate) => candidate.id === 'antigravity.accounts',
    )
    expect(command).toBeDefined()
    expect(command?.bind).toBe('ctrl+g')

    setDialogSelection(1)
    command!.run()
    await Bun.sleep(20)

    expect(dialogOptions()?.title).toBe('Antigravity accounts')
    expect(dialogOptions()?.options).toHaveLength(2)
    expect(mutations).toBe(1)
    expect(current.accounts[1]?.enabled).toBe(false)

    if (cleanup) await cleanup()
  })

  test('cleanup disposes the slot claims', async () => {
    const harness = stubContext()
    let disposed = 0
    harness.context.ui.slot = () => {
      disposed += 1
      return () => {
        disposed -= 1
      }
    }
    const plugin = createOpenCodeV2AntigravityTui({
      loadPool: async () => pool([{ email: 'a@example.test' }]),
      pollMs: 5,
      now: () => NOW,
    })
    const cleanup = await plugin.setup(harness.context as never)
    expect(disposed).toBe(2)
    if (cleanup) await cleanup()
    expect(disposed).toBe(0)
  })
})
