import { optionalChildren } from './context'
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
  derive?(inputs: Array<ResolvedPricePath | null>): Promise<RecursiveAdapterQuote | null>
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
      if (!plan.derive) {
        const inputs = await Promise.all(plan.dependencies.map(({ target, label }) => context.require(target, label)))
        return evaluatePlan(plan, inputs)
      }
      const inputs = await optionalChildren(context, plan.dependencies)
      return inputs.every(Boolean) ? evaluatePlan(plan, inputs as ResolvedPricePath[]) : derivePlan(plan, inputs)
    }
  }
}

function checkInputs(plan: PricePlan, inputs: Array<ResolvedPricePath | null>) {
  if (inputs.length !== plan.dependencies.length) throw new InvalidPricingError('Incomplete plan inputs')
  for (const [index, input] of inputs.entries()) {
    if (!input) continue
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
}

export function evaluatePlan(plan: PricePlan, inputs: ResolvedPricePath[]): RecursiveAdapterQuote {
  checkInputs(plan, inputs)
  return plan.evaluate(inputs)
}

export function derivePlan(
  plan: PricePlan,
  inputs: Array<ResolvedPricePath | null>
): Promise<RecursiveAdapterQuote | null> {
  if (!plan.derive) throw new InvalidPricingError('Plan cannot derive missing inputs')
  checkInputs(plan, inputs)
  return plan.derive(inputs)
}
