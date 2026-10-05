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
    | { title: string; options: Array<{ value: string }> }
    | undefined
  let dialogSelection: string | undefined
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
    setDialogSelection: (value: string | undefined) => {
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

/**
 * The keymap layer can only be registered from inside a component scope, so a
 * slot render is what triggers the bind. Render the available claims, then hand
 * back the registered command.
 */
function accountsCommand(
  claims: CapturedClaim[],
  layers: Array<{
    commands: Array<{ id: string; run: () => void; bind?: string }>
  }>,
) {
  for (const claim of claims) claim.render({})
  return layers[0]?.commands.find(
    (candidate) => candidate.id === 'antigravity.accounts',
  )
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
      { email: 'a@example.test', enabled: false, accountIneligible: true },
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
    const command = accountsCommand(claims, layers)
    expect(command).toBeDefined()
    expect(command?.bind).toBe('ctrl+g')

    command!.run()
    await Bun.sleep(20)
    expect(dialogOptions()?.title).toBe('Antigravity accounts')
    expect(dialogOptions()?.options).toHaveLength(2)

    // Selection carries the stable key, not the pool index.
    setDialogSelection(dialogOptions()?.options[1]?.value)
    command!.run()
    await Bun.sleep(20)

    expect(mutations).toBe(1)
    expect(current.accounts[1]?.enabled).toBe(false)

    if (cleanup) await cleanup()
  })

  test('refuses to re-enable an account Google blocked', async () => {
    // Regression: the dialog used to toggle `enabled` blindly. Because core
    // disables an account as it applies the block, that wrote
    // `enabled: true` next to `accountIneligible: true` — which core's load
    // path honours, putting an unusable account back into rotation.
    let current = pool([
      {
        email: 'blocked@example.test',
        enabled: false,
        accountIneligible: true,
      },
      { email: 'ok@example.test' },
    ])
    let mutations = 0
    const {
      claims,
      layers,
      dialogOptions,
      setDialogSelection,
      toasts,
      cleanup,
    } = await setupTui({
      loadPool: async () => current,
      mutatePool: async (mutate) => {
        mutations += 1
        const next = mutate(current)
        if (next) current = next
        return current
      },
    })

    const command = accountsCommand(claims, layers)
    command!.run()
    await Bun.sleep(20)
    setDialogSelection(dialogOptions()?.options[0]?.value)
    command!.run()
    await Bun.sleep(20)

    expect(mutations).toBe(0)
    expect(current.accounts[0]?.enabled).toBe(false)
    expect(toasts.at(-1)?.variant).toBe('warning')
    expect(toasts.at(-1)?.message).toContain('ACCOUNT_INELIGIBLE')

    if (cleanup) await cleanup()
  })

  test('refuses to re-enable an account awaiting validation', async () => {
    const current = pool([
      {
        email: 'verify@example.test',
        enabled: false,
        verificationRequired: true,
      },
    ])
    let mutations = 0
    const {
      claims,
      layers,
      dialogOptions,
      setDialogSelection,
      toasts,
      cleanup,
    } = await setupTui({
      loadPool: async () => current,
      mutatePool: async (mutate) => {
        mutations += 1
        return current
      },
    })

    const command = accountsCommand(claims, layers)
    command!.run()
    await Bun.sleep(20)
    setDialogSelection(dialogOptions()?.options[0]?.value)
    command!.run()
    await Bun.sleep(20)

    expect(mutations).toBe(0)
    expect(toasts.at(-1)?.message).toContain('validation')

    if (cleanup) await cleanup()
  })

  test('toggles the intended account after the pool shifts', async () => {
    // The dialog is built from a snapshot; the write is lock-held and may run
    // against a pool where an earlier account was removed. Toggling by the
    // captured index would then edit a different account.
    let current = pool([
      { email: 'a@example.test' },
      { email: 'target@example.test' },
    ])
    const {
      store,
      claims,
      layers,
      dialogOptions,
      setDialogSelection,
      cleanup,
    } = await setupTui({
      loadPool: async () => current,
      mutatePool: async (mutate) => {
        // Simulate a concurrent removal landing before the write.
        current = pool([{ email: 'target@example.test' }])
        const next = mutate(current)
        if (next) current = next
        return current
      },
    })

    const targetKey = store.status?.accounts[1]?.key
    expect(targetKey).toBeString()
    setDialogSelection(targetKey)
    accountsCommand(claims, layers)?.run()
    await Bun.sleep(20)

    expect(dialogOptions()?.options).toHaveLength(2)
    expect(current.accounts).toHaveLength(1)
    expect(current.accounts[0]?.enabled).toBe(false)

    if (cleanup) await cleanup()
  })

  test('warns instead of guessing when the target vanished', async () => {
    let current = pool([
      { email: 'a@example.test' },
      { email: 'target@example.test' },
    ])
    const {
      store,
      claims,
      layers,
      dialogOptions,
      setDialogSelection,
      toasts,
      cleanup,
    } = await setupTui({
      loadPool: async () => current,
      mutatePool: async (mutate) => {
        current = pool([{ email: 'a@example.test' }])
        const next = mutate(current)
        if (next) current = next
        return current
      },
    })

    setDialogSelection(store.status?.accounts[1]?.key)
    accountsCommand(claims, layers)?.run()
    await Bun.sleep(20)
    expect(dialogOptions()?.options).toHaveLength(2)
    expect(toasts.at(-1)?.variant).toBe('warning')
    expect(toasts.at(-1)?.message).toContain('changed while the dialog')

    if (cleanup) await cleanup()
  })

  test('binds the accounts command from the sidebar slot alone', async () => {
    // The keymap layer needs a component scope, so the bind is attempted from
    // slot renders. It must not depend on the prompt-footer slot succeeding.
    const harness = stubContext()
    const claims = harness.claims
    harness.context.ui.slot = (claim: Record<string, unknown>) => {
      if (claim.append === 'prompt.footer.status') {
        throw new Error('slot unavailable')
      }
      claims.push({
        target: String(claim.append),
        render: claim.render as (input: unknown) => unknown,
      })
      return () => {}
    }
    const plugin = createOpenCodeV2AntigravityTui({
      loadPool: async () => pool([{ email: 'a@example.test' }]),
      pollMs: 5,
      now: () => NOW,
    })
    const cleanup = await plugin.setup(harness.context as never)

    expect(claims.map((claim) => claim.target)).toEqual(['sidebar.footer'])
    claims[0]?.render({})
    expect(harness.layers).toHaveLength(1)
    expect(
      harness.layers[0]?.commands.find(
        (candidate) => candidate.id === 'antigravity.accounts',
      ),
    ).toBeDefined()

    if (cleanup) await cleanup()
  })

  test('reports transitions that happen while the pool is unreadable', async () => {
    let healthy = true
    let poolState = pool([{ email: 'a@example.test' }])
    const { store, toasts, cleanup } = await setupTui({
      pollMs: 5,
      now: () => NOW,
      loadPool: async () => (healthy ? poolState : null),
    })
    expect(store.status?.ready).toBe(1)

    // Simulate the server blocking the account while a read fails.
    healthy = false
    poolState = pool([
      { email: 'a@example.test', enabled: false, accountIneligible: true },
    ])
    await Bun.sleep(30)
    expect(store.status).toBeUndefined()

    healthy = true
    await Bun.sleep(30)
    expect(store.status?.accounts[0]?.state).toBe('ineligible')
    expect(toasts.length).toBeGreaterThan(0)
    expect(toasts[0]?.variant).toBe('warning')
    expect(toasts[0]?.message).toContain('ACCOUNT_INELIGIBLE')

    if (cleanup) await cleanup()
  })

  test('does not update disposed UI after a pending refresh', async () => {
    let resolveLoad: ((value: AccountStorageV4 | null) => void) | undefined
    let calls = 0
    const { store, toasts, cleanup } = await setupTui({
      pollMs: 5,
      now: () => NOW,
      loadPool: async () => {
        calls += 1
        if (calls === 1) return pool([{ email: 'a@example.test' }])
        return new Promise<AccountStorageV4 | null>((resolve) => {
          resolveLoad = resolve
        })
      },
    })
    expect(store.status?.ready).toBe(1)
    // Let the second poll start and stall on the pending load.
    await Bun.sleep(20)
    if (cleanup) await cleanup()
    resolveLoad?.(
      pool([
        { email: 'a@example.test', enabled: false, accountIneligible: true },
      ]),
    )
    await Bun.sleep(20)
    expect(store.status?.ready).toBe(1)
    expect(toasts).toEqual([])
  })

  test('applies the decision the displayed state implies', async () => {
    // Regression: a blind invert would re-enable an account another actor
    // disabled between the dialog snapshot and the write.
    let current = pool([{ email: 'a@example.test' }])
    const { store, claims, layers, setDialogSelection, cleanup } =
      await setupTui({
        loadPool: async () => current,
        mutatePool: async (mutate) => {
          current = pool([{ email: 'a@example.test', enabled: false }])
          const next = mutate(current)
          if (next) current = next
          return current
        },
      })
    const command = accountsCommand(claims, layers)
    command!.run()
    await Bun.sleep(20)
    setDialogSelection(store.status?.accounts[0]?.key)
    command!.run()
    await Bun.sleep(20)
    expect(current.accounts[0]?.enabled).toBe(false)
    if (cleanup) await cleanup()
  })

  test('refuses a block that lands while the dialog is open', async () => {
    let current = pool([{ email: 'a@example.test' }])
    const { store, claims, layers, setDialogSelection, toasts, cleanup } =
      await setupTui({
        loadPool: async () => current,
        mutatePool: async (mutate) => {
          current = pool([
            {
              email: 'a@example.test',
              enabled: false,
              accountIneligible: true,
            },
          ])
          const next = mutate(current)
          if (next) current = next
          return current
        },
      })
    const command = accountsCommand(claims, layers)
    command!.run()
    await Bun.sleep(20)
    setDialogSelection(store.status?.accounts[0]?.key)
    command!.run()
    await Bun.sleep(20)
    expect(current.accounts[0]?.enabled).toBe(false)
    expect(
      toasts.some((toast) => toast.message.includes('blocked by Google')),
    ).toBe(true)
    if (cleanup) await cleanup()
  })

  test('coalesces refreshes and stops reading after disposal', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const { cleanup } = await setupTui({
      pollMs: 5,
      loadPool: async () => {
        calls += 1
        if (calls === 1) return pool([{ email: 'a@example.test' }])
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return null
      },
    })
    // Several ticks pass while the second read hangs; they must coalesce into a
    // single queued read instead of stacking one per tick.
    await Bun.sleep(30)
    expect(calls).toBe(2)
    if (cleanup) await cleanup()
    release?.()
    await Bun.sleep(20)
    expect(calls).toBe(2)
  })

  test('registers the accounts layer exactly once across slot re-renders', async () => {
    // Host 2.0.22's ctx.keymap.commands() never lists keymap-layer commands,
    // so any "is it still registered?" probe always answers no. Slot renders
    // fire at high frequency with reactive footer content, and re-registering
    // on each render accumulates thousands of layers that stall the keymap
    // dispatcher — Ctrl+C (and every other binding) stops responding. The
    // bind is therefore once-only per TUI session.
    const harness = stubContext()
    ;(
      harness.context.keymap as unknown as {
        commands: () => Array<{ id: string }>
      }
    ).commands = () => []
    const plugin = createOpenCodeV2AntigravityTui({
      loadPool: async () => pool([{ email: 'a@example.test' }]),
      pollMs: 5,
      now: () => NOW,
    })
    const cleanup = await plugin.setup(harness.context as never)

    for (let index = 0; index < 50; index += 1) {
      harness.claims[0]!.render({})
      harness.claims[1]!.render({})
    }
    expect(harness.layers).toHaveLength(1)
    expect(
      harness.layers[0]?.commands.find(
        (candidate) => candidate.id === 'antigravity.accounts',
      ),
    ).toBeDefined()

    if (cleanup) await cleanup()
  })

  test('refuses to toggle an account whose identity can shift', async () => {
    const current = pool([{}])
    let mutations = 0
    const {
      claims,
      layers,
      dialogOptions,
      setDialogSelection,
      toasts,
      cleanup,
    } = await setupTui({
      loadPool: async () => current,
      mutatePool: async (mutate) => {
        mutations += 1
        return current
      },
    })
    const command = accountsCommand(claims, layers)
    command!.run()
    await Bun.sleep(20)
    setDialogSelection(dialogOptions()?.options[0]?.value)
    command!.run()
    await Bun.sleep(20)
    expect(mutations).toBe(0)
    expect(toasts.at(-1)?.variant).toBe('warning')
    expect(toasts.at(-1)?.message).toContain('no address on file')
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
