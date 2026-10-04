import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ROUTABLE_MODEL_IDS } from '../src/plugin.ts'

const exampleConfig = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../example/opencode.json', import.meta.url)),
    'utf8',
  ),
) as {
  plugins?: string[]
  providers?: Record<string, { models?: Record<string, unknown> }>
}

describe('OpenCode 2 example config', () => {
  it('registers the adapter plugin', () => {
    expect(exampleConfig.plugins).toContain(
      '@cortexkit/opencode-v2-antigravity-auth',
    )
  })

  it('declares exactly the models the bridge routes', () => {
    const models = Object.keys(
      exampleConfig.providers?.google?.models ?? {},
    ).sort()
    expect(models).toEqual([...ROUTABLE_MODEL_IDS].sort())
  })
})
