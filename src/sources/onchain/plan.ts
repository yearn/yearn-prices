import { InvalidPricingError } from './errors'
import type { RecursiveAdapterQuote, RecursivePriceAdapter, RecursivePriceTarget, ResolvedPricePath } from './types'

export interface PriceDependency {
  target: RecursivePriceTarget
  label: string
}

/** Immutable historical state plus a pure calculation. No child prices or
 * provider access are needed to discover every dependency of this route. */
export interface PricePlan {
  dependencies: PriceDependency[]
  metadata: Record<string, unknown>
  evaluate(inputs: ResolvedPricePath[]): RecursiveAdapterQuote
}

export interface PlannedPriceAdapter extends RecursivePriceAdapter {
  discover(target: RecursivePriceTarget): Promise<PricePlan | null>
}

/** Keep request-path recursion and offline graph pricing on identical math. */
export function plannedAdapter(name: string, discover: PlannedPriceAdapter['discover']): PlannedPriceAdapter {
  return {
    name,
    discover,
    async resolve(target, context) {
      const plan = await discover(target)
      if (!plan) return null
      const inputs = await Promise.all(plan.dependencies.map(({ target, label }) => context.require(target, label)))
      return evaluatePlan(plan, inputs)
    }
  }
}

export function evaluatePlan(plan: PricePlan, inputs: ResolvedPricePath[]): RecursiveAdapterQuote {
  if (inputs.length !== plan.dependencies.length) throw new InvalidPricingError('Incomplete plan inputs')
  for (const [index, input] of inputs.entries()) {
    const target = plan.dependencies[index].target
    if (
      input.chainId !== target.chainId ||
      input.token.toLowerCase() !== target.token.toLowerCase() ||
      input.requestedTimestamp !== target.timestamp ||
      !Number.isFinite(input.priceUsd) ||
      input.priceUsd <= 0
    ) {
      throw new InvalidPricingError('Plan input does not match its dependency')
    }
  }
  return plan.evaluate(inputs)
}
