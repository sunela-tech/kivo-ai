// Usage tokens: what one generation costs, from configs/plans.yaml (via
// public/data/app.json). The same formula as inkos/plans.py:cost().

export class CostError extends Error {}

/** -> integer tokens; throws CostError for a model without a price or steps out of range */
export function tokenCost(usage, modelId, size, steps) {
  const c = usage && usage.costs && usage.costs[modelId];
  if (!c) throw new CostError('this model has no usage price');
  let base;
  if (c.per_step !== undefined) {
    const lo = usage.steps.min, hi = usage.steps.max, n = Number(steps);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new CostError(`steps must be a whole number from ${lo} to ${hi}`);
    base = c.per_step * n;
  } else {
    base = c.image ?? c.clip ?? 0;
  }
  const f = (c.sizes && (c.sizes[size] ?? c.sizes[String(size)])) || 1;
  return Math.round(base * f);
}
