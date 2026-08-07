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
 * The margin range the cost/sell conversions can actually represent.
 * At 100 both costFromMargin and sellFromMargin collapse to 0, and below 0 the reverse
 * derivation (derivedMarginPct) floors at 0 — so a stored value outside this range can
 * never round-trip, and the stored margin stops describing the stored cost.
 */
export const MIN_MARGIN_PCT = 0;
export const MAX_MARGIN_PCT = 99;

/** Clamp a margin % into the representable range. The single clamp every margin input shares. */
export function clampMarginPct(pct: number): number {
  // NaN first — it compares false against everything, so it must not fall through to `return pct`.
  // ±Infinity deliberately clamps by comparison (an overflowing entry lands on the nearer bound).
  if (Number.isNaN(pct)) return MIN_MARGIN_PCT;
  if (pct < MIN_MARGIN_PCT) return MIN_MARGIN_PCT;
  if (pct > MAX_MARGIN_PCT) return MAX_MARGIN_PCT;
  return pct;
}

/** What a margin input shows when markupPercent is unset. Any rate derived while the field is
 *  empty must use this same number, or the visible margin stops matching the stored cost. */
export const DEFAULT_MARGIN_PCT = 25;

export type NormalizedMarginInput = {
  /** Value to persist to `markupPercent`; null clears the field. */
  stored: string | null;
  /** Margin the budget rate must be derived from, or null when no rate should be derived. */
  derivedFrom: number | null;
};

/**
 * Normalize a raw margin-input keystroke into the pair that must be written together.
 *
 * The invariant: `stored` and `derivedFrom` always describe the SAME margin. Clamping the
 * value that feeds the rate while persisting the raw input is what let `markupPercent = 100`
 * sit next to a cost derived from 99% — and since costFromMargin/sellFromMargin both return 0
 * at >= 100, a stored 100 also collapsed downstream sell/cost math to zero.
 */
export function normalizeMarginInput(raw: string): NormalizedMarginInput {
  // Empty clears the stored value, but the input then displays the default — so a rate derived
  // now must come from that default for the two to keep agreeing.
  if (raw === "") return { stored: null, derivedFrom: DEFAULT_MARGIN_PCT };

  const parsed = parseFloat(raw);
  // A fragment mid-typing ("-", ".") is not a margin yet: keep the keystroke, derive nothing.
  // Substituting a default here would pin the cost to a margin the user never entered.
  // Only NaN qualifies — an entry that overflows to Infinity ("1e309") is a real number and
  // must clamp like any other out-of-range value rather than being stored as typed.
  if (Number.isNaN(parsed)) return { stored: raw, derivedFrom: null };

  const clamped = clampMarginPct(parsed);
  // Preserve the raw text when it is already in range, so "25." and "25.0" survive typing.
  // Safe because it re-parses to `clamped`, which is what keeps stored and derived in agreement.
  return { stored: clamped === parsed ? raw : String(clamped), derivedFrom: clamped };
}

/**
 * Format a derived per-unit rate for storage. Two decimals for money, except where that would
 * round a real cost down to "0.00" — a zero rate reads as "no budget" (internalBudget returns
 * null, saveEstimate persists null), which would contradict the margin stored beside it.
 */
export function formatDerivedRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0.00";
  return rate >= 0.005 ? rate.toFixed(2) : rate.toPrecision(2);
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
  return clampMarginPct((1 - rate / price) * 100);
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
