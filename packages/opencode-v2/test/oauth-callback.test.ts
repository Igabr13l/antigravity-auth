import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'

import { waitForAntigravityCode } from '../src/oauth-callback.ts'

/** Reserve a currently-free port by binding and immediately releasing it. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('could not resolve a probe port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

function callbackUrl(port: number, query: string): string {
  return `http://127.0.0.1:${port}/oauth-callback?${query}`
}

describe('waitForAntigravityCode', () => {
  test('resolves with the code for a matching state', async () => {
    const port = await freePort()
    const code = waitForAntigravityCode('state-ok', { port, timeoutMs: 5_000 })
    await Bun.sleep(30)
    const response = await fetch(
      callbackUrl(port, 'state=state-ok&code=abc123'),
    )
    expect(response.status).toBe(200)
    await expect(code).resolves.toBe('abc123')
  })

  test('rejects a redirect whose state does not match', async () => {
    const port = await freePort()
    const code = waitForAntigravityCode('expected', { port, timeoutMs: 500 })
    await Bun.sleep(30)
    const rejected = await fetch(callbackUrl(port, 'state=other&code=abc123'))
    expect(rejected.status).toBe(400)
    await expect(code).rejects.toThrow(/timed out/)
  })

  test('a new attempt supersedes a hung one on the same port', async () => {
    const port = await freePort()
    const first = waitForAntigravityCode('state-first', {
      port,
      timeoutMs: 5_000,
    })
    await Bun.sleep(30)
    // Regression: without closing the previous listener, binding the fixed
    // redirect port again failed with EADDRINUSE.
    const second = waitForAntigravityCode('state-second', {
      port,
      timeoutMs: 5_000,
    })
    await expect(first).rejects.toThrow(/superseded/)
    const response = await fetch(
      callbackUrl(port, 'state=state-second&code=second-code'),
    )
    expect(response.status).toBe(200)
    await expect(second).resolves.toBe('second-code')
  })

  test('rejects when no redirect arrives before the timeout', async () => {
    const port = await freePort()
    await expect(
      waitForAntigravityCode('state-timeout', { port, timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/)
  })
})
