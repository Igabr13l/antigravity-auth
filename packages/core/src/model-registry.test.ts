import { describe, expect, it } from 'bun:test'

import {
  getGemini35FlashAntigravityModel,
  getGemini35FlashGeminiCliFallbackModel,
  getGemini36FlashAntigravityModel,
  getGemini37FlashAntigravityModel,
  getGemini38FlashAntigravityModel,
  getPublicModelDefinitions,
  getResolverAliasMap,
} from './model-registry.ts'

const REQUIRED_PUBLIC_MODEL_FIELDS = [
  'id',
  'name',
  'release_date',
  'attachment',
  'reasoning',
  'temperature',
  'tool_call',
  'limit',
  'cost',
  'options',
] as const

describe('model registry', () => {
  it('is the source of truth for the current public OpenCode model catalog', () => {
    const definitions = getPublicModelDefinitions()
    const modelNames = Object.keys(definitions).sort()

    expect(modelNames).toEqual([
      'antigravity-claude-opus-4-6-thinking',
      'antigravity-claude-sonnet-4-6-thinking',
      'antigravity-gemini-3.1-flash-image',
      'antigravity-gemini-3.1-pro',
      'antigravity-gemini-3.5-flash',
      'antigravity-gemini-3.6-flash',
      'antigravity-gemini-3.7-flash',
      'antigravity-gemini-3.8-flash',
      'antigravity-gpt-oss-120b-medium',
    ])

    for (const definition of Object.values(definitions)) {
      for (const field of REQUIRED_PUBLIC_MODEL_FIELDS) {
        expect(definition).toHaveProperty(field)
      }
    }
  })

  it('preserves live Gemini 3.5 Flash route mappings', () => {
    expect(getGemini35FlashAntigravityModel()).toBe('gemini-3-flash-agent')
    expect(getGemini35FlashAntigravityModel('high')).toBe(
      'gemini-3-flash-agent',
    )
    expect(getGemini35FlashAntigravityModel('medium')).toBe(
      'gemini-3.5-flash-low',
    )
    expect(getGemini35FlashAntigravityModel('low')).toBe(
      'gemini-3.5-flash-extra-low',
    )
    expect(getGemini35FlashGeminiCliFallbackModel()).toBe(
      'gemini-3-flash-preview',
    )
  })

  it('preserves live Gemini 3.6 Flash route mappings', () => {
    expect(getGemini36FlashAntigravityModel()).toBe('gemini-3.6-flash-medium')
    expect(getGemini36FlashAntigravityModel('high')).toBe(
      'gemini-3.6-flash-high',
    )
    expect(getGemini36FlashAntigravityModel('medium')).toBe(
      'gemini-3.6-flash-medium',
    )
    expect(getGemini36FlashAntigravityModel('low')).toBe('gemini-3.6-flash-low')
  })

  it('preserves live Gemini 3.7 Flash route mappings', () => {
    expect(getGemini37FlashAntigravityModel()).toBe('gemini-3.7-flash-medium')
    expect(getGemini37FlashAntigravityModel('high')).toBe(
      'gemini-3.7-flash-high',
    )
    expect(getGemini37FlashAntigravityModel('medium')).toBe(
      'gemini-3.7-flash-medium',
    )
    expect(getGemini37FlashAntigravityModel('low')).toBe('gemini-3.7-flash-low')
  })

  it('preserves live Gemini 3.8 Flash route mappings', () => {
    expect(getGemini38FlashAntigravityModel()).toBe('gemini-3.8-flash-medium')
    expect(getGemini38FlashAntigravityModel('high')).toBe(
      'gemini-3.8-flash-high',
    )
    expect(getGemini38FlashAntigravityModel('medium')).toBe(
      'gemini-3.8-flash-medium',
    )
    expect(getGemini38FlashAntigravityModel('low')).toBe('gemini-3.8-flash-low')
  })

  it('exposes untiered Claude 4.6 models with disabled variants', () => {
    const definitions = getPublicModelDefinitions()
    const opus = definitions['antigravity-claude-opus-4-6-thinking']
    const sonnet = definitions['antigravity-claude-sonnet-4-6-thinking']

    expect(opus?.name).toBe('Claude Opus 4.6 Thinking (Antigravity)')
    expect(opus?.variants).toEqual({
      low: { disabled: true },
      high: { disabled: true },
    })

    expect(sonnet?.name).toBe('Claude Sonnet 4.6 Thinking (Antigravity)')
    expect(sonnet?.variants).toEqual({
      low: { disabled: true },
      high: { disabled: true },
    })

    expect(definitions).not.toHaveProperty(
      'antigravity-claude-opus-5-5-thinking',
    )
    expect(definitions).not.toHaveProperty(
      'antigravity-claude-sonnet-5-5-thinking',
    )
  })

  it('keeps resolver aliases for supported agy CLI variants', () => {
    const aliases = getResolverAliasMap()

    expect(aliases['gemini-3.5-flash-medium']).toBe('gemini-3.5-flash')
    expect(aliases['gemini-3.6-flash-medium']).toBe('gemini-3.6-flash')
    expect(aliases['gemini-3.7-flash-medium']).toBe('gemini-3.7-flash')
    expect(aliases['gemini-3.8-flash-medium']).toBe('gemini-3.8-flash')
    expect(aliases['gemini-claude-opus-4-6-thinking-medium']).toBe(
      'claude-opus-4-6-thinking',
    )
    expect(aliases['claude-opus-4-6-thinking-low']).toBe(
      'claude-opus-4-6-thinking',
    )
    expect(aliases['claude-opus-4-6-thinking-medium']).toBe(
      'claude-opus-4-6-thinking',
    )
    expect(aliases['claude-opus-4-6-thinking-high']).toBe(
      'claude-opus-4-6-thinking',
    )
    expect(aliases['claude-opus-4-6-thinking-max']).toBe(
      'claude-opus-4-6-thinking',
    )
    expect(aliases['gemini-claude-sonnet-4-6-thinking-high']).toBe(
      'claude-sonnet-4-6',
    )
    expect(aliases['gpt-oss-120b']).toBe('gpt-oss-120b-medium')
  })

  it('does not expose restricted Gemini 3.8 Flash Cyber', () => {
    expect(getPublicModelDefinitions()).not.toHaveProperty(
      'antigravity-gemini-3.8-flash-cyber',
    )
  })

  it('matches the live GPT-OSS capability metadata', () => {
    expect(
      getPublicModelDefinitions()['antigravity-gpt-oss-120b-medium'],
    ).toMatchObject({
      reasoning: true,
      limit: { context: 131072, output: 32768 },
    })
  })

  it('advertises image output only on the image route', () => {
    expect(
      getPublicModelDefinitions()['antigravity-gemini-3.1-flash-image'],
    ).toMatchObject({
      reasoning: false,
      modalities: {
        input: ['text', 'image'],
        output: ['text', 'image'],
      },
    })
  })
})
