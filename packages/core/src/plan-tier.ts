export type PlanTier = 'free' | 'plus' | 'pro' | 'ultra' | 'unknown'

export const PLAN_TIER_RANK: Record<PlanTier, number> = {
  unknown: 0,
  free: 1,
  plus: 2,
  pro: 3,
  ultra: 4,
}

/**
 * Normalizes an upstream tier string into a canonical PlanTier union.
 *
 * Upstream Google Antigravity / Code Assist tier IDs include:
 * - Ultra: ultra-tier, gemini-ultra-tier, g1-ultra, ultra
 * - Pro: pro-tier, gemini-pro-tier, standard-tier, enterprise-tier, g1-pro, premium
 * - Plus: plus-tier, gemini-plus-tier, g1-plus, plus
 * - Free: free-tier, basic-tier, starter-tier, free
 */
export function normalizePlanTier(rawTierId?: string | null): PlanTier {
  if (!rawTierId || typeof rawTierId !== 'string') {
    return 'unknown'
  }
  const normalized = rawTierId.trim().toLowerCase()
  if (!normalized) {
    return 'unknown'
  }

  if (normalized.includes('ultra')) {
    return 'ultra'
  }
  if (
    normalized.includes('pro') ||
    normalized.includes('standard') ||
    normalized.includes('enterprise') ||
    normalized.includes('premium')
  ) {
    return 'pro'
  }
  if (normalized.includes('plus')) {
    return 'plus'
  }
  if (
    normalized.includes('free') ||
    normalized.includes('basic') ||
    normalized.includes('starter')
  ) {
    return 'free'
  }
  return 'unknown'
}

/**
 * Resolves an account's plan tier, giving priority to `capturedPaidTierId` over `capturedTierId`.
 *
 * In upstream responses, `currentTier.id` is often set to `"free-tier"` even when
 * the account holds an active paid subscription represented in `paidTier`.
 */
export function resolveAccountPlanTier(account?: object | null): PlanTier {
  if (!account || typeof account !== 'object') {
    return 'unknown'
  }
  const paidId =
    'capturedPaidTierId' in account &&
    typeof (account as { capturedPaidTierId?: unknown }).capturedPaidTierId ===
      'string'
      ? (account as { capturedPaidTierId: string }).capturedPaidTierId
      : undefined
  const currentId =
    'capturedTierId' in account &&
    typeof (account as { capturedTierId?: unknown }).capturedTierId === 'string'
      ? (account as { capturedTierId: string }).capturedTierId
      : undefined
  const fromPaid = normalizePlanTier(paidId)
  if (fromPaid !== 'unknown') {
    return fromPaid
  }
  return normalizePlanTier(currentId)
}

/**
 * Formats a PlanTier for user-facing display.
 */
export function formatPlanTier(tier: PlanTier): string {
  switch (tier) {
    case 'free':
      return 'Free'
    case 'plus':
      return 'Plus'
    case 'pro':
      return 'Pro'
    case 'ultra':
      return 'Ultra'
    case 'unknown':
      return 'Unknown'
  }
}

/**
 * Checks whether `current` plan satisfies `required` plan according to the plan hierarchy:
 * unknown (0) < free (1) < plus (2) < pro (3) < ultra (4).
 * A requirement of 'unknown' or 'free' is always satisfied.
 */
export function isPlanAtLeast(current: PlanTier, required: PlanTier): boolean {
  if (required === 'unknown' || required === 'free') {
    return true
  }
  return PLAN_TIER_RANK[current] >= PLAN_TIER_RANK[required]
}

/**
 * Determines the minimum required plan tier for a given model ID.
 */
export function getMinimumPlanForModel(modelId: string): PlanTier {
  const lower = modelId.toLowerCase()
  if (lower.includes('carbon')) {
    return 'ultra'
  }
  if (lower.includes('opus') || lower.includes('ultra')) {
    return 'pro'
  }
  if (
    lower.includes('sonnet') ||
    lower.includes('gpt-oss') ||
    lower.includes('argon')
  ) {
    return 'plus'
  }
  return 'free'
}

/**
 * Evaluates whether an account is eligible to execute the specified model.
 * If the account's plan is unknown, evaluates to true for backwards compatibility.
 */
export function isAccountEligibleForModel(
  account: object,
  modelId: string,
): boolean {
  const plan = resolveAccountPlanTier(account)
  if (plan === 'unknown') {
    return true
  }
  const required = getMinimumPlanForModel(modelId)
  return isPlanAtLeast(plan, required)
}
