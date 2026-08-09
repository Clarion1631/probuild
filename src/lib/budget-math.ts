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
 * The gross margin equal to the legacy 25% markup-on-cost, for the paths that
 * used to apply one (Room Studio furnish). base * 1.25 === base / 0.8, which
 * is what makes converting those writers to margin price-neutral.
 *
 * Deliberately NOT `DEFAULT_MARGIN_PCT` (25) below. That one is what an empty
 * margin input shows, and it matches EstimateItem.markupPercent @default(25) —
 * those 25s always meant a 25% MARGIN and are already canonical. This constant
 * exists only to reproduce old markup-on-cost prices exactly. Different
 * numbers, different jobs — do not merge them.
 */
export const LEGACY_MARKUP_MARGIN_PCT = 20;

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
  /** The margin the budget rate must be derived from. */
  derivedFrom: number;
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
  const parsed = parseFloat(raw);

  // Empty, or a fragment that is not a number yet ("-", "."), clears the stored value. The
  // input then displays the default, so the rate has to be derived from that same default to
  // keep the two agreeing. Storing the fragment instead would be worse than useless:
  // saveEstimate turns an unparseable markupPercent into the default anyway, so it would
  // persist a margin that contradicts the cost sitting next to it.
  // Only NaN counts as a fragment — an entry that overflows to Infinity ("1e309") is a real
  // number and clamps like any other out-of-range value.
  if (raw === "" || Number.isNaN(parsed)) return { stored: null, derivedFrom: DEFAULT_MARGIN_PCT };

  const clamped = clampMarginPct(parsed);
  // Preserve the raw text when it is already in range, so "25." and "25.0" survive typing.
  // Safe because it re-parses to `clamped`, which is what keeps stored and derived in agreement.
  return { stored: clamped === parsed ? raw : String(clamped), derivedFrom: clamped };
}

/**
 * Format a derived per-unit rate for storage, at enough precision that the margin implied by
 * the stored rate still matches the margin stored beside it.
 *
 * Cents are plenty for ordinary unit prices, but rounding to cents is not scale-free: a half
 * cent is a rounding error of `0.5 / price` percent of margin. At a $1,500 sell that is
 * invisible; at a $0.49 sell it moves the implied margin by a full point, and at $0.01 it can
 * round a 50% margin to a rate implying 0%. `budgetRate`/`baseCost` are unconstrained Decimals,
 * so the extra places persist. Kept to whatever keeps the implied margin accurate to 2dp.
 */
export function formatDerivedRate(rate: number, price: number): string {
  // A zero rate reads as "no budget" (internalBudget returns null, saveEstimate persists null),
  // which would contradict any non-zero margin stored beside it.
  if (!Number.isFinite(rate) || rate <= 0) return "0.00";
  return rate.toFixed(derivedRateDecimals(price));
}

/** Decimal places formatDerivedRate stores a rate at, at this price scale. Exported shape of the
 *  rule so marginIsStale can size its tolerance from the SAME rounding — if these two ever
 *  disagree, healthy rows start warning. */
export function derivedRateDecimals(price: number): number {
  const needed = Number.isFinite(price) && price > 0 ? Math.ceil(4 - Math.log10(price)) : 2;
  return Math.min(10, Math.max(2, needed));
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
 * The margin a rate/price pair actually implies, UNCLAMPED — or null when no margin exists
 * (non-finite input, or a sell price of zero, which has no margin to speak of).
 *
 * derivedMarginPct is this value clamped. The two only disagree when the pair cannot be
 * expressed inside [MIN_MARGIN_PCT, MAX_MARGIN_PCT], which is exactly when the stored
 * markupPercent stops describing the stored rate — see marginIsUnrepresentable.
 */
export function rawMarginPct(rate: number, price: number): number | null {
  if (!Number.isFinite(rate) || !Number.isFinite(price) || price <= 0) return null;
  return (1 - rate / price) * 100;
}

/**
 * True when the budget rate sitting next to a sell price cannot be described by any storable
 * margin, so the clamped markupPercent persisted beside it is a lie.
 *
 * Two ways in, and BOTH matter:
 *  - rate > price  — the line loses money. Clamps to 0, which claims cost === price.
 *  - rate < price/100 — margin over 99. Clamps to 99, which claims a cost 100x the real one.
 *  - price <= 0 with a rate — no sell to earn a margin on, and any stored margin is meaningless.
 *
 * We deliberately do NOT rewrite the rate to make the margin true: the rate is a cost the user
 * typed, and silently moving it is worse than showing a warning (product decision, 2026-08-09 —
 * the alternative was lowering MIN_MARGIN_PCT below 0, which would have put a sign change
 * through all 19 consumers of markupPercent).
 */
export function marginIsUnrepresentable(rate: number, price: number): boolean {
  if (rate === 0) return false; // no budget rate at all — nothing to contradict
  // A negative or non-finite rate is not "no budget", it is a bad budget: it still persists to
  // budgetRate (and internalBudget will happily multiply it out), while marginPatchForRate
  // clears the margin, which then displays as the default. Warn instead of reading it as absent.
  if (!Number.isFinite(rate) || rate < 0) return true;
  if (!Number.isFinite(price) || price <= 0) return true; // a cost with no sell price
  const raw = rawMarginPct(rate, price);
  if (raw === null) return false;
  return raw < MIN_MARGIN_PCT || raw > MAX_MARGIN_PCT;
}

/**
 * How far apart a stored and a derived margin may sit before they count as disagreeing.
 *
 * A row written by either writer can legitimately be off by BOTH of these at once, so the
 * tolerance is their sum. Sizing it at just one of them makes ordinary saves warn — rate $2.95
 * at price $8 stores 63.13 against a true 63.125, exactly one half-step out.
 *
 *  - marginPatchForRate persists the margin at 2dp: half a step is 0.005 of margin.
 *  - normalizeMarginInput persists the typed margin verbatim and derives the RATE, which
 *    formatDerivedRate rounds to derivedRateDecimals(price) places. Half a step of rate is
 *    (0.5 * 10^-d / price) * 100 percent of margin — the term that scales with price.
 *
 * Both bounds are attained exactly, and floating-point subtraction lands a hair either side of
 * them, so the comparison must have real headroom rather than sit on the boundary.
 */
const MARGIN_STORAGE_HALF_STEP = 0.005;

function rateRoundingMarginDrift(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return ((0.5 * 10 ** -derivedRateDecimals(price)) / price) * 100;
}

/**
 * True when a margin already stored on the item does not describe the rate/price pair stored
 * beside it. Distinct from marginIsUnrepresentable: this catches rows where the derived margin
 * IS representable but the persisted number is simply stale — the shape left behind by editing
 * a sell price before that path re-derived the margin (price 100 -> 200 leaving rate 75 next to
 * a stored 25 while the line really ran 62.5%). Edits self-heal such a row, so this only ever
 * flags history.
 */
export function marginIsStale(storedPct: number | null, rate: number, price: number): boolean {
  if (storedPct === null || !Number.isFinite(storedPct)) return false;
  if (!Number.isFinite(rate) || rate <= 0) return false;
  const raw = rawMarginPct(rate, price);
  if (raw === null) return false;
  // An unrepresentable pair is reported by marginIsUnrepresentable; don't double-flag it.
  if (raw < MIN_MARGIN_PCT || raw > MAX_MARGIN_PCT) return false;
  return Math.abs(raw - storedPct) > MARGIN_STORAGE_HALF_STEP + rateRoundingMarginDrift(price);
}

/**
 * The patch that must be written whenever a budget rate and a sell price are paired up —
 * from the rate input, and from the sell-price input that silently invalidated it before.
 *
 * Rate <= 0 (or blank) means "no budget", so the margin is cleared rather than left stale:
 * saveEstimate reads a null markupPercent as the default, which is what an item with no
 * budget looks like anyway. A margin left over from a deleted rate describes nothing.
 */
export function marginPatchForRate(rate: number, price: number): { markupPercent: string | null } {
  if (!Number.isFinite(rate) || rate <= 0) return { markupPercent: null };
  if (!Number.isFinite(price) || price <= 0) return { markupPercent: null };
  return { markupPercent: derivedMarginPct(rate, price).toFixed(2) };
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
