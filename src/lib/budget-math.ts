/**
 * Budget math utilities for estimate internal costing.
 * Uses plain JS arithmetic (sufficient for display-only calculations).
 * Precision-critical storage uses Prisma Decimal on the server side.
 *
 * CANONICAL SEMANTIC: `EstimateItem.markupPercent` stores GROSS MARGIN ON
 * SELL PRICE despite its name (cost = sell * (1 - m/100), sell = cost / (1 - m/100)).
 * baseCost + unitCost are the authoritative pair; markupPercent is derived
 * from them (see derivedMarginPct). Do not treat it as markup-on-cost.
 */

/**
 * Round a number to `decimals` places, collapsing IEEE-754 floating-point
 * drift before rounding. Plain `Math.round(x * f) / f` can disagree with an
 * algebraically equivalent computation when a value lands exactly on a
 * rounding boundary (e.g. 20.40 / 0.8 === 25.499999999999996, which rounds
 * down, while the algebraically identical 20.40 * 1.25 === 25.5, which
 * rounds up). Snapping to 12 significant digits first removes that drift so
 * sellFromMargin(cost, margin) rounds the same way the legacy
 * markup-on-cost formula did — this is what keeps price conversion neutral
 * (NO SELL PRICE MAY MOVE).
 *
 * Uses toPrecision (relative) rather than toFixed (absolute): a fixed number
 * of decimal places leaves too little headroom at decimals=2 and would round
 * genuinely-below-the-boundary values UP (1.004999996 -> 1.01). Binary drift
 * from these operations shows up around the 15th significant digit, so 12 is
 * comfortably clear of real precision while still absorbing the noise.
 */
export function roundMoney(value: number, decimals = 0): number {
  const f = 10 ** decimals;
  const scaled = value * f;
  if (!Number.isFinite(scaled)) return value;
  return Math.round(Number(scaled.toPrecision(12))) / f;
}

/**
 * Default gross margin for items produced by paths that USED to apply a 25%
 * markup-on-cost (Room Studio furnish, AI takeoff). Equals that legacy markup
 * exactly (base * 1.25 === base / 0.8), which is what makes the conversion
 * price-neutral.
 *
 * Deliberately NOT the same as the plain `25` default used by the schema and
 * by hand-added estimate items (EstimateItem.markupPercent @default(25),
 * saveEstimate's fallback). Those 25s were always a 25% MARGIN and are already
 * canonical, so they must stay 25 — do not "unify" them to this constant.
 */
export const DEFAULT_MARGIN_PCT = 20;

/**
 * Convert a legacy markup-on-cost percentage to the canonical gross-margin
 * percentage. Formula: margin% = markup% / (100 + markup%) * 100.
 */
export function marginFromMarkup(markupPct: number): number {
  return (markupPct / (100 + markupPct)) * 100;
}

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
  if (isNaN(rate) || rate === 0) return null;
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
 * Calculate cost from sell price and target margin percentage.
 * Formula: cost = sell × (1 - margin/100).
 * Inverse of sellFromMargin — used when margin is adjusted and we need to
 * update budget cost while keeping the customer-facing price fixed.
 */
export function costFromMargin(sell: number, marginPct: number): number {
  if (marginPct >= 100) return 0;
  return sell * (1 - marginPct / 100);
}

/**
 * Derive gross-margin percentage from a per-unit cost and per-unit sell price.
 * Since budgetQuantity is locked to sell quantity for AI-filled budgets,
 * quantities cancel and only per-unit figures are needed.
 *
 * Formula: margin% = (1 - cost/price) × 100, clamped to [0, 99].
 *
 * NOTE: the stored field is named `markupPercent` but semantically holds
 * gross margin (see sellFromMargin which inverts it). This helper preserves
 * that convention — do not apply a true markup formula here.
 */
export function derivedMarginPct(rate: number, price: number): number {
  if (!Number.isFinite(rate) || !Number.isFinite(price) || price <= 0) return 0;
  const m = (1 - rate / price) * 100;
  if (m < 0) return 0;
  if (m > 99) return 99;
  return m;
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
