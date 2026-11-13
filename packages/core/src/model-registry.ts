import type { ProviderModel } from './model-types.ts'
import { getMinimumPlanForModel, type PlanTier } from './plan-tier.ts'
import type { ThinkingTier } from './transform/types.ts'

export type ModelThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

export interface ModelThinkingConfig {
  thinkingBudget: number
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel
  thinkingConfig?: ModelThinkingConfig
  disabled?: boolean
}

export interface ModelLimit {
  context: number
  output: number
}

export type ModelModality = 'text' | 'image' | 'pdf'
export type ModelQuotaGroup = 'gemini' | 'argon' | 'non-gemini'

export interface ModelModalities {
  input: ModelModality[]
  output: ModelModality[]
}

export interface OpencodeModelDefinition extends ProviderModel {
  id: string
  name: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  limit: ModelLimit
  modalities: ModelModalities
  cost: {
    input: number
    output: number
  }
  options: Record<string, unknown>
  variants?: Record<string, ModelVariant>
  minPlan?: PlanTier
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>

interface OpencodeModelDefinitionInput {
  name: string
  reasoning: boolean
  limit: ModelLimit
  modalities: ModelModalities
  variants?: Record<string, ModelVariant>
  minPlan?: PlanTier
}

interface AntigravityTieredRouteMetadata {
  defaultModel: string
  byTier: Partial<Record<ThinkingTier, string>>
}

interface GeminiFlashRouteMetadata {
  antigravity: AntigravityTieredRouteMetadata
  geminiCliFallbackModel: string
}

const DEFAULT_MODALITIES: ModelModalities = {
  input: ['text', 'image', 'pdf'],
  output: ['text'],
}

const MODEL_RELEASE_DATE = ''
const DEFAULT_COST = { input: 0, output: 0 }
const DEFAULT_OPTIONS: Record<string, unknown> = {}

function defineModel(
  id: string,
  model: OpencodeModelDefinitionInput,
): OpencodeModelDefinition {
  return {
    id,
    release_date: MODEL_RELEASE_DATE,
    attachment: model.modalities.input.some((modality) => modality !== 'text'),
    temperature: true,
    tool_call: true,
    cost: { ...DEFAULT_COST },
    options: { ...DEFAULT_OPTIONS },
    minPlan: model.minPlan ?? getMinimumPlanForModel(id),
    ...model,
  }
}

const FLASH_VARIANTS: Record<string, ModelVariant> = {
  minimal: { thinkingLevel: 'minimal' },
  low: { thinkingLevel: 'low' },
  medium: { thinkingLevel: 'medium' },
  high: { thinkingLevel: 'high' },
}

const PRO_VARIANTS: Record<string, ModelVariant> = {
  low: { thinkingLevel: 'low' },
  medium: { thinkingLevel: 'low' },
  high: { thinkingLevel: 'high' },
}

const ARGON_CARBON_VARIANTS: Record<string, ModelVariant> = {
  low: { thinkingLevel: 'low' },
  medium: { thinkingLevel: 'medium' },
  high: { thinkingLevel: 'high' },
}

const CLAUDE_55_VARIANTS: Record<string, ModelVariant> = {
  low: { thinkingConfig: { thinkingBudget: 8192 } },
  medium: { thinkingConfig: { thinkingBudget: 16384 } },
  high: { thinkingConfig: { thinkingBudget: 32768 } },
}

const ALL_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  'antigravity-gemini-4-argon': defineModel('antigravity-gemini-4-argon', {
    name: 'Gemini 4 Argon (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: ARGON_CARBON_VARIANTS,
    minPlan: 'plus',
  }),
  'antigravity-gemini-4-carbon': defineModel('antigravity-gemini-4-carbon', {
    name: 'Gemini 4 Carbon (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: ARGON_CARBON_VARIANTS,
    minPlan: 'ultra',
  }),
  'antigravity-gemini-3.1-pro': defineModel('antigravity-gemini-3.1-pro', {
    name: 'Gemini 3.1 Pro (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: PRO_VARIANTS,
    minPlan: 'free',
  }),
  'antigravity-gemini-3.8-flash': defineModel('antigravity-gemini-3.8-flash', {
    name: 'Gemini 3.8 Flash (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: FLASH_VARIANTS,
    minPlan: 'free',
  }),
  'antigravity-gemini-3.7-flash': defineModel('antigravity-gemini-3.7-flash', {
    name: 'Gemini 3.7 Flash (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: FLASH_VARIANTS,
    minPlan: 'free',
  }),
  'antigravity-gemini-3.6-flash': defineModel('antigravity-gemini-3.6-flash', {
    name: 'Gemini 3.6 Flash (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: FLASH_VARIANTS,
    minPlan: 'free',
  }),
  'antigravity-gemini-3.5-flash': defineModel('antigravity-gemini-3.5-flash', {
    name: 'Gemini 3.5 Flash (Antigravity)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: FLASH_VARIANTS,
    minPlan: 'free',
  }),
  'antigravity-claude-sonnet-4-6-thinking': defineModel(
    'antigravity-claude-sonnet-4-6-thinking',
    {
      name: 'Claude Sonnet 4.6 Thinking (Antigravity)',
      reasoning: true,
      limit: { context: 250000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { disabled: true },
        high: { disabled: true },
      },
      minPlan: 'free',
    },
  ),
  'antigravity-claude-opus-4-6-thinking': defineModel(
    'antigravity-claude-opus-4-6-thinking',
    {
      name: 'Claude Opus 4.6 Thinking (Antigravity)',
      reasoning: true,
      limit: { context: 250000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { disabled: true },
        high: { disabled: true },
      },
      minPlan: 'free',
    },
  ),
  'antigravity-claude-sonnet-5-5-thinking': defineModel(
    'antigravity-claude-sonnet-5-5-thinking',
    {
      name: 'Claude Sonnet 5.5 (Thinking)',
      reasoning: true,
      limit: { context: 250000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      variants: CLAUDE_55_VARIANTS,
      minPlan: 'plus',
    },
  ),
  'antigravity-claude-opus-5-5-thinking': defineModel(
    'antigravity-claude-opus-5-5-thinking',
    {
      name: 'Claude Opus 5.5 (Thinking)',
      reasoning: true,
      limit: { context: 250000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      variants: CLAUDE_55_VARIANTS,
      minPlan: 'pro',
    },
  ),
  'antigravity-gemini-3.1-flash-image': defineModel(
    'antigravity-gemini-3.1-flash-image',
    {
      name: 'Gemini 3.1 Flash Image (Antigravity)',
      reasoning: false,
      limit: { context: 66000, output: 33000 },
      modalities: {
        input: ['text', 'image'],
        output: ['text', 'image'],
      },
      minPlan: 'free',
    },
  ),
  'antigravity-gpt-oss-120b-medium': defineModel(
    'antigravity-gpt-oss-120b-medium',
    {
      name: 'GPT-OSS 120B Medium (Antigravity)',
      reasoning: true,
      limit: { context: 131072, output: 32768 },
      modalities: DEFAULT_MODALITIES,
      minPlan: 'plus',
    },
  ),
  'gemini-2.5-flash': defineModel('gemini-2.5-flash', {
    name: 'Gemini 2.5 Flash (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-2.5-pro': defineModel('gemini-2.5-pro', {
    name: 'Gemini 2.5 Pro (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-3-flash-preview': defineModel('gemini-3-flash-preview', {
    name: 'Gemini 3 Flash Preview (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-3.1-pro-preview': defineModel('gemini-3.1-pro-preview', {
    name: 'Gemini 3.1 Pro Preview (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-3.5-flash-preview': defineModel('gemini-3.5-flash-preview', {
    name: 'Gemini 3.5 Flash Preview (Gemini CLI)',
    reasoning: true,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  }),
  'gemini-3.1-flash-image': defineModel('gemini-3.1-flash-image', {
    name: 'Gemini 3.1 Flash Image (Gemini CLI)',
    reasoning: false,
    limit: { context: 66000, output: 33000 },
    modalities: {
      input: ['text', 'image'],
      output: ['text', 'image'],
    },
  }),
  'gemini-3.1-flash-image-preview': defineModel(
    'gemini-3.1-flash-image-preview',
    {
      name: 'Gemini 3.1 Flash Image Preview (Gemini CLI)',
      reasoning: false,
      limit: { context: 66000, output: 33000 },
      modalities: {
        input: ['text', 'image'],
        output: ['text', 'image'],
      },
    },
  ),
  'gemini-3.1-pro-preview-customtools': defineModel(
    'gemini-3.1-pro-preview-customtools',
    {
      name: 'Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)',
      reasoning: true,
      limit: { context: 1048576, output: 65535 },
      modalities: DEFAULT_MODALITIES,
    },
  ),
}

const RESOLVER_ALIASES: Record<string, string> = {
  'gemini-4-argon-minimal': 'gemini-4-argon',
  'gemini-4-argon-low': 'gemini-4-argon',
  'gemini-4-argon-medium': 'gemini-4-argon',
  'gemini-4-argon-high': 'gemini-4-argon',
  'gemini-4-carbon-minimal': 'gemini-4-carbon',
  'gemini-4-carbon-low': 'gemini-4-carbon',
  'gemini-4-carbon-medium': 'gemini-4-carbon',
  'gemini-4-carbon-high': 'gemini-4-carbon',
  'gemini-3.1-pro-low': 'gemini-3.1-pro',
  'gemini-3.1-pro-medium': 'gemini-3.1-pro',
  'gemini-3.1-pro-high': 'gemini-3.1-pro',
  'gemini-3-flash-low': 'gemini-3-flash',
  'gemini-3-flash-medium': 'gemini-3-flash',
  'gemini-3-flash-high': 'gemini-3-flash',
  'gemini-3.5-flash-minimal': 'gemini-3.5-flash',
  'gemini-3.5-flash-low': 'gemini-3.5-flash',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash',
  'gemini-3.5-flash-high': 'gemini-3.5-flash',
  'gemini-3.6-flash-minimal': 'gemini-3.6-flash',
  'gemini-3.6-flash-low': 'gemini-3.6-flash',
  'gemini-3.6-flash-medium': 'gemini-3.6-flash',
  'gemini-3.6-flash-high': 'gemini-3.6-flash',
  'gemini-3.7-flash-minimal': 'gemini-3.7-flash',
  'gemini-3.7-flash-low': 'gemini-3.7-flash',
  'gemini-3.7-flash-medium': 'gemini-3.7-flash',
  'gemini-3.7-flash-high': 'gemini-3.7-flash',
  'gemini-3.8-flash-minimal': 'gemini-3.8-flash',
  'gemini-3.8-flash-low': 'gemini-3.8-flash',
  'gemini-3.8-flash-medium': 'gemini-3.8-flash',
  'gemini-3.8-flash-high': 'gemini-3.8-flash',
  'gemini-claude-opus-4-6-thinking-low': 'claude-opus-4-6-thinking',
  'gemini-claude-opus-4-6-thinking-medium': 'claude-opus-4-6-thinking',
  'gemini-claude-opus-4-6-thinking-high': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking-low': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking-medium': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking-high': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking-max': 'claude-opus-4-6-thinking',
  'claude-sonnet-4-6-thinking-max': 'claude-sonnet-4-6',
  'gemini-claude-sonnet-4-6-thinking-low': 'claude-sonnet-4-6',
  'gemini-claude-sonnet-4-6-thinking-medium': 'claude-sonnet-4-6',
  'gemini-claude-sonnet-4-6-thinking-high': 'claude-sonnet-4-6',
  'gemini-claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-low': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-medium': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking-high': 'claude-sonnet-4-6',
  'gpt-oss-120b': 'gpt-oss-120b-medium',
}

const GEMINI_35_FLASH_ROUTES: GeminiFlashRouteMetadata = {
  antigravity: {
    defaultModel: 'gemini-3-flash-agent',
    byTier: {
      minimal: 'gemini-3.5-flash-extra-low',
      low: 'gemini-3.5-flash-extra-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
    },
  },
  geminiCliFallbackModel: 'gemini-3-flash-preview',
}

const GEMINI_36_FLASH_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-3.6-flash-medium',
  byTier: {
    minimal: 'gemini-3.6-flash-low',
    low: 'gemini-3.6-flash-low',
    medium: 'gemini-3.6-flash-medium',
    high: 'gemini-3.6-flash-high',
  },
}

const GEMINI_37_FLASH_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-3.7-flash-medium',
  byTier: {
    minimal: 'gemini-3.7-flash-low',
    low: 'gemini-3.7-flash-low',
    medium: 'gemini-3.7-flash-medium',
    high: 'gemini-3.7-flash-high',
  },
}

const GEMINI_38_FLASH_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-3.8-flash-medium',
  byTier: {
    minimal: 'gemini-3.8-flash-low',
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high',
  },
}

const GEMINI_4_ARGON_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-4-argon-high',
  byTier: {
    minimal: 'gemini-4-argon-low',
    low: 'gemini-4-argon-low',
    medium: 'gemini-4-argon-medium',
    high: 'gemini-4-argon-high',
  },
}

const GEMINI_4_CARBON_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'gemini-4-carbon-high',
  byTier: {
    minimal: 'gemini-4-carbon-low',
    low: 'gemini-4-carbon-low',
    medium: 'gemini-4-carbon-medium',
    high: 'gemini-4-carbon-high',
  },
}

const CLAUDE_OPUS_55_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'claude-opus-5-5-medium',
  byTier: {
    minimal: 'claude-opus-5-5-low',
    low: 'claude-opus-5-5-low',
    medium: 'claude-opus-5-5-medium',
    high: 'claude-opus-5-5-high',
  },
}

const CLAUDE_SONNET_55_ROUTES: AntigravityTieredRouteMetadata = {
  defaultModel: 'claude-sonnet-5-5-medium',
  byTier: {
    minimal: 'claude-sonnet-5-5-low',
    low: 'claude-sonnet-5-5-low',
    medium: 'claude-sonnet-5-5-medium',
    high: 'claude-sonnet-5-5-high',
  },
}

const QUOTA_GROUP_BY_MODEL_ID: Record<string, ModelQuotaGroup> = {
  'claude-opus-4-6-thinking': 'non-gemini',
  'claude-opus-4-6': 'non-gemini',
  'claude-sonnet-4-6-thinking': 'non-gemini',
  'claude-sonnet-4-6': 'non-gemini',
  'claude-opus-5-5': 'non-gemini',
  'claude-opus-5-5-low': 'non-gemini',
  'claude-opus-5-5-medium': 'non-gemini',
  'claude-opus-5-5-high': 'non-gemini',
  'claude-opus-5-5-thinking': 'non-gemini',
  'claude-sonnet-5-5': 'non-gemini',
  'claude-sonnet-5-5-low': 'non-gemini',
  'claude-sonnet-5-5-medium': 'non-gemini',
  'claude-sonnet-5-5-high': 'non-gemini',
  'claude-sonnet-5-5-thinking': 'non-gemini',
  'gemini-4-argon': 'argon',
  'gemini-4-argon-minimal': 'argon',
  'gemini-4-argon-low': 'argon',
  'gemini-4-argon-medium': 'argon',
  'gemini-4-argon-high': 'argon',
  'gemini-4-carbon': 'gemini',
  'gemini-4-carbon-minimal': 'gemini',
  'gemini-4-carbon-low': 'gemini',
  'gemini-4-carbon-medium': 'gemini',
  'gemini-4-carbon-high': 'gemini',
  'gemini-pro-agent': 'gemini',
  'gemini-3.1-pro': 'gemini',
  'gemini-3.1-pro-low': 'gemini',
  'gemini-3.1-pro-medium': 'gemini',
  'gemini-3.1-pro-high': 'gemini',
  'gemini-3-flash': 'gemini',
  'gemini-3-flash-agent': 'gemini',
  'gemini-3.5-flash-minimal': 'gemini',
  'gemini-3.5-flash-low': 'gemini',
  'gemini-3.5-flash-extra-low': 'gemini',
  'gemini-3.6-flash-minimal': 'gemini',
  'gemini-3.6-flash-low': 'gemini',
  'gemini-3.6-flash-medium': 'gemini',
  'gemini-3.6-flash-high': 'gemini',
  'gemini-3.6-flash-tiered': 'gemini',
  'gemini-3.7-flash-minimal': 'gemini',
  'gemini-3.7-flash-low': 'gemini',
  'gemini-3.7-flash-medium': 'gemini',
  'gemini-3.7-flash-high': 'gemini',
  'gemini-3.7-flash-tiered': 'gemini',
  'gemini-3.8-flash-minimal': 'gemini',
  'gemini-3.8-flash-low': 'gemini',
  'gemini-3.8-flash-medium': 'gemini',
  'gemini-3.8-flash-high': 'gemini',
  'gemini-3.8-flash-tiered': 'gemini',
  'gemini-3.1-flash-image': 'gemini',
  'gpt-oss-120b': 'non-gemini',
  'gpt-oss-120b-medium': 'non-gemini',
}

const ANTIGRAVITY_OPENCODE_MODEL_IDS = [
  'antigravity-gemini-4-argon',
  'antigravity-gemini-4-carbon',
  'antigravity-gemini-3.8-flash',
  'antigravity-gemini-3.7-flash',
  'antigravity-gemini-3.6-flash',
  'antigravity-gemini-3.5-flash',
  'antigravity-gemini-3.1-pro',
  'antigravity-claude-sonnet-5-5-thinking',
  'antigravity-claude-opus-5-5-thinking',
  'antigravity-claude-sonnet-4-6-thinking',
  'antigravity-claude-opus-4-6-thinking',
  'antigravity-gemini-3.1-flash-image',
  'antigravity-gpt-oss-120b-medium',
] as const

let dynamicModelDefinitions: OpencodeModelDefinitions = {}

export function registerDynamicModels(models: OpencodeModelDefinitions): void {
  dynamicModelDefinitions = { ...dynamicModelDefinitions, ...models }
}

export function clearDynamicModels(): void {
  dynamicModelDefinitions = {}
}

function pickModelDefinitions(
  ids: readonly string[],
): OpencodeModelDefinitions {
  return Object.fromEntries(ids.map((id) => [id, ALL_MODEL_DEFINITIONS[id]!]))
}

export const OPENCODE_MODEL_DEFINITIONS = pickModelDefinitions(
  ANTIGRAVITY_OPENCODE_MODEL_IDS,
)

export function getPublicModelDefinitions(): OpencodeModelDefinitions {
  return {
    ...OPENCODE_MODEL_DEFINITIONS,
    ...dynamicModelDefinitions,
  }
}

export function getAntigravityOpencodeModelIds(): string[] {
  return [
    ...ANTIGRAVITY_OPENCODE_MODEL_IDS,
    ...Object.keys(dynamicModelDefinitions),
  ]
}

export function getResolverAliasMap(): Record<string, string> {
  return RESOLVER_ALIASES
}

export function getGemini35FlashAntigravityModel(tier?: ThinkingTier): string {
  if (!tier) {
    return GEMINI_35_FLASH_ROUTES.antigravity.defaultModel
  }
  return (
    GEMINI_35_FLASH_ROUTES.antigravity.byTier[tier] ??
    GEMINI_35_FLASH_ROUTES.antigravity.defaultModel
  )
}

export function getGemini35FlashGeminiCliFallbackModel(): string {
  return GEMINI_35_FLASH_ROUTES.geminiCliFallbackModel
}

function getTieredAntigravityModel(
  routes: AntigravityTieredRouteMetadata,
  tier?: ThinkingTier,
): string {
  return tier
    ? (routes.byTier[tier] ?? routes.defaultModel)
    : routes.defaultModel
}

export function getGemini36FlashAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(GEMINI_36_FLASH_ROUTES, tier)
}

export function getGemini37FlashAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(GEMINI_37_FLASH_ROUTES, tier)
}

export function getGemini38FlashAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(GEMINI_38_FLASH_ROUTES, tier)
}

export function getGemini4ArgonAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(GEMINI_4_ARGON_ROUTES, tier)
}

export function getGemini4CarbonAntigravityModel(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(GEMINI_4_CARBON_ROUTES, tier)
}

/** Wire model for Claude Opus 5.5, tiered low/medium/high (default medium). */
export function getClaudeOpus55Model(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(CLAUDE_OPUS_55_ROUTES, tier)
}

/** Wire model for Claude Sonnet 5.5, tiered low/medium/high (default medium). */
export function getClaudeSonnet55Model(tier?: ThinkingTier): string {
  return getTieredAntigravityModel(CLAUDE_SONNET_55_ROUTES, tier)
}

export function getQuotaGroupForModel(
  modelId: string,
): ModelQuotaGroup | undefined {
  const normalized = modelId.toLowerCase()
  return (
    QUOTA_GROUP_BY_MODEL_ID[normalized] ??
    // Check Claude / GPT-OSS substrings BEFORE the `gemini` substring so
    // a `gemini-claude-*` alias (which is a Claude route exposed under
    // a `gemini-` namespace) attributes to the non-gemini pool rather
    // than the gemini pool. Substring matching is required because the
    // alias IDs start with `gemini-` but contain `claude`.
    (normalized.includes('argon')
      ? 'argon'
      : normalized.includes('claude') || normalized.includes('gpt-oss')
        ? 'non-gemini'
        : normalized.startsWith('gemini') || normalized.startsWith('tab_')
          ? 'gemini'
          : undefined)
  )
}

/**
 * Returns true when a model only exists on Antigravity endpoints (daily/autopush)
 * and should not fall back to the Gemini CLI prod endpoint on 503/529 capacity errors.
 */
export function isAntigravityOnlyModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase().replace(/^antigravity-/, '')
  return (
    normalized.includes('claude') ||
    normalized.includes('gpt-oss') ||
    normalized.includes('image') ||
    normalized.includes('imagen') ||
    normalized.startsWith('tab_') ||
    normalized.startsWith('gemini-4-')
  )
}
