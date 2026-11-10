import { describe, expect, it } from 'bun:test'

import {
  getClaudeOpus55Model,
  getClaudeSonnet55Model,
  getGemini4ArgonAntigravityModel,
  getGemini4CarbonAntigravityModel,
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
      'antigravity-claude-opus-5-5-thinking',
      'antigravity-claude-sonnet-4-6-thinking',
      'antigravity-claude-sonnet-5-5-thinking',
      'antigravity-gemini-3.1-flash-image',
      'antigravity-gemini-3.1-pro',
      'antigravity-gemini-3.5-flash',
      'antigravity-gemini-3.6-flash',
      'antigravity-gemini-3.7-flash',
      'antigravity-gemini-3.8-flash',
      'antigravity-gemini-4-argon',
      'antigravity-gemini-4-carbon',
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

  it('exposes untiered Claude 4.6 models and tiered Claude 5.5 + Gemini 4 Argon/Carbon models', () => {
    const definitions = getPublicModelDefinitions()
    const opus = definitions['antigravity-claude-opus-4-6-thinking']
    const sonnet = definitions['antigravity-claude-sonnet-4-6-thinking']
    const opus55 = definitions['antigravity-claude-opus-5-5-thinking']
    const sonnet55 = definitions['antigravity-claude-sonnet-5-5-thinking']
    const argon = definitions['antigravity-gemini-4-argon']
    const carbon = definitions['antigravity-gemini-4-carbon']

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

    expect(opus55?.name).toBe('Claude Opus 5.5 (Thinking)')
    expect(opus55?.variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      medium: { thinkingConfig: { thinkingBudget: 16384 } },
      high: { thinkingConfig: { thinkingBudget: 32768 } },
    })

    expect(sonnet55?.name).toBe('Claude Sonnet 5.5 (Thinking)')
    expect(sonnet55?.variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      medium: { thinkingConfig: { thinkingBudget: 16384 } },
      high: { thinkingConfig: { thinkingBudget: 32768 } },
    })

    expect(argon?.name).toBe('Gemini 4 Argon (Antigravity)')
    expect(argon?.variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })
    expect(getGemini4ArgonAntigravityModel()).toBe('gemini-4-argon-high')
    expect(getGemini4ArgonAntigravityModel('low')).toBe('gemini-4-argon-low')
    expect(getGemini4ArgonAntigravityModel('medium')).toBe(
      'gemini-4-argon-medium',
    )
    expect(getGemini4ArgonAntigravityModel('high')).toBe('gemini-4-argon-high')

    expect(carbon?.name).toBe('Gemini 4 Carbon (Antigravity)')
    expect(getGemini4CarbonAntigravityModel()).toBe('gemini-4-carbon-high')
    expect(getClaudeOpus55Model()).toBe('claude-opus-5-5-medium')
    expect(getClaudeSonnet55Model()).toBe('claude-sonnet-5-5-medium')
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

  it('exposes full thinking variants on Gemini Flash models', () => {
    const definitions = getPublicModelDefinitions()
    const flash38 = definitions['antigravity-gemini-3.8-flash']
    expect(flash38?.variants).toEqual({
      minimal: { thinkingLevel: 'minimal' },
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })
  })

  it('annotates model definitions with minimum plan tier requirements', () => {
    const definitions = getPublicModelDefinitions()
    expect(definitions['antigravity-gemini-4-carbon']?.minPlan).toBe('ultra')
    expect(definitions['antigravity-claude-opus-5-5-thinking']?.minPlan).toBe(
      'pro',
    )
    expect(definitions['antigravity-claude-opus-4-6-thinking']?.minPlan).toBe(
      'pro',
    )
    expect(definitions['antigravity-claude-sonnet-5-5-thinking']?.minPlan).toBe(
      'plus',
    )
    expect(definitions['antigravity-claude-sonnet-4-6-thinking']?.minPlan).toBe(
      'plus',
    )
    expect(definitions['antigravity-gemini-4-argon']?.minPlan).toBe('plus')
    expect(definitions['antigravity-gpt-oss-120b-medium']?.minPlan).toBe('plus')
    expect(definitions['antigravity-gemini-3.8-flash']?.minPlan).toBe('free')
  })

  it('supports dynamic model registration and clearing', () => {
    const {
      registerDynamicModels,
      clearDynamicModels,
    } = require('./model-registry.ts')
    try {
      registerDynamicModels({
        'antigravity-custom-test': {
          id: 'antigravity-custom-test',
          name: 'Custom Test Model',
          release_date: '',
          attachment: false,
          reasoning: true,
          temperature: true,
          tool_call: true,
          limit: { context: 1000, output: 500 },
          modalities: { input: ['text'], output: ['text'] },
          cost: { input: 0, output: 0 },
          options: {},
          minPlan: 'plus',
        },
      })
      expect(getPublicModelDefinitions()).toHaveProperty(
        'antigravity-custom-test',
      )
    } finally {
      clearDynamicModels()
    }
    expect(getPublicModelDefinitions()).not.toHaveProperty(
      'antigravity-custom-test',
    )
  })
})
