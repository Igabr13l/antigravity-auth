import type {
  ModelVariant,
  OpencodeModelDefinitions,
} from './model-registry.ts'
import { getMinimumPlanForModel } from './plan-tier.ts'
import type { FetchAvailableModelsResponse } from './quota-manager.ts'

/**
 * Transforms an upstream `fetchAvailableModels` API response into typed
 * `OpencodeModelDefinition` entries with appropriate variants, limits, and
 * minimum plan tier annotations.
 */
export function discoverModelsFromApiResponse(
  response: FetchAvailableModelsResponse,
): OpencodeModelDefinitions {
  const definitions: OpencodeModelDefinitions = {}
  if (!response?.models) {
    return definitions
  }

  for (const [rawModelId, entry] of Object.entries(response.models)) {
    const modelId = rawModelId.trim()
    if (!modelId) {
      continue
    }

    const id = modelId.startsWith('antigravity-')
      ? modelId
      : `antigravity-${modelId}`
    const lower = modelId.toLowerCase()
    const isImage = lower.includes('image') || lower.includes('imagen')
    const isClaude = lower.includes('claude')
    const isGpt = lower.includes('gpt')
    const isFlash = lower.includes('flash')
    const isPro = lower.includes('pro')

    const displayName =
      entry.displayName ??
      entry.modelName ??
      (modelId.startsWith('antigravity-')
        ? modelId
        : `${modelId} (Antigravity)`)

    let variants: Record<string, ModelVariant> | undefined
    if (isClaude) {
      variants = { low: { disabled: true }, high: { disabled: true } }
    } else if (lower.includes('hydrogen')) {
      variants = {
        low: { thinkingLevel: 'low' },
        medium: { thinkingLevel: 'medium' },
        high: { thinkingLevel: 'high' },
        xhigh: { thinkingLevel: 'xhigh' },
      }
    } else if (isFlash) {
      variants = {
        minimal: { thinkingLevel: 'minimal' },
        low: { thinkingLevel: 'low' },
        medium: { thinkingLevel: 'medium' },
        high: { thinkingLevel: 'high' },
      }
    } else if (isPro) {
      variants = {
        low: { thinkingLevel: 'low' },
        medium: { thinkingLevel: 'low' },
        high: { thinkingLevel: 'high' },
      }
    }

    const limit = isClaude
      ? { context: 250000, output: 64000 }
      : isGpt
        ? { context: 131072, output: 32768 }
        : isImage
          ? { context: 66000, output: 33000 }
          : { context: 1048576, output: 65536 }

    const modalities = isImage
      ? {
          input: ['text' as const, 'image' as const],
          output: ['text' as const, 'image' as const],
        }
      : {
          input: ['text' as const, 'image' as const, 'pdf' as const],
          output: ['text' as const],
        }

    definitions[id] = {
      id,
      name: displayName,
      release_date: '',
      attachment: modalities.input.some((m) => m !== 'text'),
      reasoning: !isImage,
      temperature: true,
      tool_call: true,
      limit,
      modalities,
      cost: { input: 0, output: 0 },
      options: {},
      minPlan: getMinimumPlanForModel(id),
      ...(variants ? { variants } : {}),
    }
  }

  return definitions
}
