/**
 * Budget math utilities for estimate internal costing.
 * Uses plain JS arithmetic (sufficient for display-only calculations).
 * Precision-critical storage uses Prisma Decimal on the server side.
 */

/**
 * Calculate internal budget for an estimate item.
 * Uses budgetQuantity (falls back to quantity) × budgetRate (falls back to baseCost).
 * Returns null if no rate is available — rendered as "—" in the UI.
 */
export function internalBudget(item: {
  budgetQuantity?: number | null;
  quantity: number;
  budgetRate?: string | number | null;
  baseCost?: string | number | null;
}): number | null {
  const qty = item.budgetQuantity ?? item.quantity;
  const rateRaw = item.budgetRate ?? item.baseCost;
  if (rateRaw == null || rateRaw === "") return null;
  const rate = typeof rateRaw === "string" ? parseFloat(rateRaw) : rateRaw;
  if (isNaN(rate)) return null;
  return qty * rate;
}

/**
 * Calculate buffer percentage: (sellTotal - internalTotal) / sellTotal × 100.
 * Returns null if sell total is zero or budget is null — rendered as "—" in the UI.
 */
export function bufferPercent(item: {
  quantity: number;
  unitCost: string | number;
  budgetQuantity?: number | null;
  budgetRate?: string | number | null;
  baseCost?: string | number | null;
}): number | null {
  const qty = typeof item.quantity === "string" ? parseFloat(item.quantity) : item.quantity;
  const uc = typeof item.unitCost === "string" ? parseFloat(item.unitCost.toString()) : item.unitCost;
  const sell = qty * uc;
  if (sell === 0) return null;
  const budget = internalBudget(item);
  if (budget == null) return null;
  return ((sell - budget) / sell) * 100;
}

/**
 * Calculate sell price from cost and target margin percentage.
 * Formula: sell = cost / (1 - margin/100).
 * Returns 0 if margin >= 100 (would be infinite).
 */
export function sellFromMargin(cost: number, marginPct: number): number {
  if (marginPct >= 100) return 0;
  return cost / (1 - marginPct / 100);
}

/**
 * Color class for buffer percentage badge.
 * Green >= 20%, amber 10-19%, red < 10%.
 */
export function bufferColor(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct >= 20) return "text-emerald-600";
  if (pct >= 10) return "text-amber-600";
  return "text-red-600";
}

/**
 * Background color class for buffer percentage badge.
 */
export function bufferBgColor(pct: number | null): string {
  if (pct == null) return "bg-slate-50";
  if (pct >= 20) return "bg-emerald-50";
  if (pct >= 10) return "bg-amber-50";
  return "bg-red-50";
}
