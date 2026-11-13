import { describe, expect, it } from 'bun:test'

import { discoverModelsFromApiResponse } from './model-discovery.ts'

describe('model-discovery', () => {
  it('returns empty record for empty or undefined response', () => {
    expect(discoverModelsFromApiResponse({})).toEqual({})
    expect(discoverModelsFromApiResponse({ models: {} })).toEqual({})
  })

  it('transforms new Gemini Flash model with full thinking variants', () => {
    const definitions = discoverModelsFromApiResponse({
      models: {
        'gemini-3.9-flash': {
          displayName: 'Gemini 3.9 Flash (Antigravity)',
        },
      },
    })

    const model = definitions['antigravity-gemini-3.9-flash']
    expect(model).toBeDefined()
    expect(model?.name).toBe('Gemini 3.9 Flash (Antigravity)')
    expect(model?.reasoning).toBe(true)
    expect(model?.limit).toEqual({ context: 1048576, output: 65536 })
    expect(model?.variants).toEqual({
      minimal: { thinkingLevel: 'minimal' },
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'medium' },
      high: { thinkingLevel: 'high' },
    })
    expect(model?.minPlan).toBe('free')
  })

  it('transforms new Pro model with pro thinking variants', () => {
    const definitions = discoverModelsFromApiResponse({
      models: {
        'gemini-3.2-pro': {
          displayName: 'Gemini 3.2 Pro (Antigravity)',
        },
      },
    })

    const model = definitions['antigravity-gemini-3.2-pro']
    expect(model).toBeDefined()
    expect(model?.reasoning).toBe(true)
    expect(model?.variants).toEqual({
      low: { thinkingLevel: 'low' },
      medium: { thinkingLevel: 'low' },
      high: { thinkingLevel: 'high' },
    })
    expect(model?.minPlan).toBe('free')
  })

  it('transforms Claude model with disabled variants and pro plan for opus 5.5 and free for 4.6', () => {
    const definitions = discoverModelsFromApiResponse({
      models: {
        'claude-opus-5-5-thinking': {
          displayName: 'Claude Opus 5.5 Thinking',
        },
        'claude-opus-4-6-thinking': {
          displayName: 'Claude Opus 4.6 Thinking',
        },
        'claude-sonnet-4-6-thinking': {
          displayName: 'Claude Sonnet 4.6 Thinking',
        },
      },
    })

    const opus55 = definitions['antigravity-claude-opus-5-5-thinking']
    expect(opus55?.variants).toEqual({
      low: { disabled: true },
      high: { disabled: true },
    })
    expect(opus55?.minPlan).toBe('pro')

    const opus46 = definitions['antigravity-claude-opus-4-6-thinking']
    expect(opus46?.variants).toEqual({
      low: { disabled: true },
      high: { disabled: true },
    })
    expect(opus46?.minPlan).toBe('free')

    const sonnet = definitions['antigravity-claude-sonnet-4-6-thinking']
    expect(sonnet?.minPlan).toBe('free')
  })

  it('transforms image model without reasoning and with image output modality', () => {
    const definitions = discoverModelsFromApiResponse({
      models: {
        'gemini-3.2-flash-image': {
          displayName: 'Gemini 3.2 Flash Image',
        },
      },
    })

    const imageModel = definitions['antigravity-gemini-3.2-flash-image']
    expect(imageModel?.reasoning).toBe(false)
    expect(imageModel?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text', 'image'],
    })
  })
})
