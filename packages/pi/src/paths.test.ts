import { afterEach, describe, expect, it } from 'bun:test'
import { getPiAntigravityAuthFile, getPiConfigDir } from './paths.ts'

describe('getPiConfigDir', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env.PI_AGENT_DIR = originalEnv.PI_AGENT_DIR
  })

  it('returns default ~/.pi/agent when PI_AGENT_DIR not set', () => {
    delete process.env.PI_AGENT_DIR
    const dir = getPiConfigDir()
    expect(dir).toContain('.pi/agent')
  })

  it('respects PI_AGENT_DIR env override', () => {
    process.env.PI_AGENT_DIR = '/custom/pi/dir'
    expect(getPiConfigDir()).toBe('/custom/pi/dir')
  })

  it('trims whitespace from PI_AGENT_DIR', () => {
    process.env.PI_AGENT_DIR = '  /custom/pi/dir  '
    expect(getPiConfigDir()).toBe('/custom/pi/dir')
  })

  it('falls back to default for empty string', () => {
    process.env.PI_AGENT_DIR = ''
    expect(getPiConfigDir()).toContain('.pi/agent')
  })
})

describe('getPiAntigravityAuthFile', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env.PI_AGENT_DIR = originalEnv.PI_AGENT_DIR
    process.env.PI_ANTIGRAVITY_AUTH_FILE = originalEnv.PI_ANTIGRAVITY_AUTH_FILE
  })

  it('defaults to <configDir>/antigravity-accounts.json', () => {
    delete process.env.PI_AGENT_DIR
    delete process.env.PI_ANTIGRAVITY_AUTH_FILE
    const file = getPiAntigravityAuthFile()
    expect(file).toContain('antigravity-accounts.json')
    expect(file).toContain('.pi/agent')
  })

  it('respects PI_ANTIGRAVITY_AUTH_FILE override', () => {
    process.env.PI_ANTIGRAVITY_AUTH_FILE = '/etc/pi/accounts.json'
    expect(getPiAntigravityAuthFile()).toBe('/etc/pi/accounts.json')
  })

  it('uses PI_AGENT_DIR for the default path', () => {
    process.env.PI_AGENT_DIR = '/custom/dir'
    delete process.env.PI_ANTIGRAVITY_AUTH_FILE
    expect(getPiAntigravityAuthFile()).toBe(
      '/custom/dir/antigravity-accounts.json',
    )
  })
})
