/**
 * Sales-tax option resolution for the estimate editor.
 *
 * The editor picks a rate from a list built out of two sources: the company's configured
 * `CompanySettings.salesTaxes`, and the estimate's OWN stored `taxRateName`/`taxRatePercent`.
 * The second one exists because a save rewrites `taxRateName`, `taxRatePercent` and
 * `totalAmount` from whichever option is active — so if the editor can't resolve the rate the
 * estimate was quoted at, the first save silently re-quotes the client at the company default.
 *
 * Identity here is the option `key`, and a key is OPAQUE AND GENERATED (`company:<index>`), never
 * a display name. Keying on the name loses in four ways that all cost real money:
 *   - two company rows can share a name. /settings/sales-taxes does not dedupe, so
 *     "Sales Tax"@8.8 and "Sales Tax"@9.15 can both exist; a by-name key makes the second one
 *     unreachable and every lookup lands on the first.
 *   - the stored name COLLIDES with a company tax at a different rate, so a by-name lookup
 *     returns the company entry and the stored rate becomes unreachable. This is the common
 *     case, not the exotic one: `api/takeoffs/convert-to-estimate` stores the literal name
 *     "Sales Tax" for any derived rate it could not uniquely match to settings.
 *   - a company row named `__saved__` or `__exempt__` would shadow the synthetic saved option
 *     or trigger the picker's exemption branch. Generated keys cannot collide with either.
 *   - the rate was stored with no name at all (legacy and API writers), so there is nothing
 *     to look up by.
 *
 * Because keys are POSITIONAL they are only unique within one option set: deleting a company row
 * shifts every key after it, so `company:1` can come to mean a different tax. Anything holding a
 * key across a rebuild must re-establish identity by (name, rate) — see `reconcileTaxKey`.
 *
 * WHY NOT `company:<row.id>`. It looks like the obvious upgrade — stable across a reorder — and it
 * is rejected on purpose. /settings/sales-taxes mints ids as `Date.now().toString()` and enforces
 * uniqueness NOWHERE, so two rows can carry the same id (hand-edited settings JSON, a future bulk
 * import, a duplicated row). An id-keyed lookup would then make the second row unreachable and land
 * every selection on the first — precisely the by-name failure this redesign exists to kill, just
 * with a different collision source. Positional keys are unique BY CONSTRUCTION. The one thing ids
 * would buy — surviving a reorder — is already bought by `reconcileTaxKey` re-matching on
 * (name, rate), which additionally works for legacy rows that carry no id at all.
 *
 * A stored rate of 0 is an answer (rate zero), not an absence — only null means "unset".
 *
 * EXEMPTION IS NOT A KEY. `taxExempt` is its own column and its own piece of editor state; the
 * picker shows `EXEMPT_TAX_KEY` as a row but that value is never stored in `selectedTaxKey`. A
 * null key therefore means "nothing selected", never "exempt", so `reconcileTaxKey` is free to
 * repair it. Encoding exemption in the key made a non-exempt estimate whose settings went from
 * empty to populated keep a null key, render the first row, and price at the company default.
 */

/** Option key for the estimate's own saved rate. Reserved; a company row can never mint it. */
export const SAVED_TAX_KEY = "__saved__";

/** Option key for the picker's "Tax Exempt" entry. Reserved, same as above.
 *  This is a `<select>` VALUE only; it is never held in `selectedTaxKey` (see the module doc). */
export const EXEMPT_TAX_KEY = "__exempt__";

/**
 * Option key for "this estimate has a rate we could not name a number for". Reserved, same as
 * above. Selecting it writes `taxRatePercent: null` and prices at the editor's legacy 8.8%
 * fallback — i.e. it changes nothing at all, which is the point.
 */
export const UNRATED_TAX_KEY = "__unrated__";

/** Company options key on their POSITION, so duplicate names stay individually selectable. */
export function companyTaxKey(index: number): string {
    return `company:${index}`;
}

export type CompanySalesTax = { id?: string; name: string; rate: number; isDefault?: boolean };

export type TaxOption = {
    key: string;
    /** Written back to `Estimate.taxRateName` verbatim on save — null included. */
    name: string | null;
    /** Display text for the picker. Never null, unlike `name`. */
    label: string;
    /**
     * Percent, or null for the `UNRATED_TAX_KEY` option ONLY. Null is not "0%": it means the
     * estimate carries no rate we can state, so the save must leave `taxRatePercent` null and the
     * editor must keep applying its legacy 8.8% fallback. Every consumer that divides by 100 has
     * to branch on it — `taxFieldsForSave`'s `??` already does the right thing.
     */
    rate: number | null;
    isDefault: boolean;
    /** True for the estimate's own saved rate when settings no longer carry it. */
    orphaned: boolean;
};

export type TaxOptionSet = {
    /** Company options followed by the saved option, when there is one. */
    options: TaxOption[];
    /** The saved-rate option, or null when settings already cover the stored rate. */
    savedOption: TaxOption | null;
    /** Fallback when the selected key resolves to nothing. Company options only. */
    defaultOption: TaxOption | null;
    /**
     * What the editor should select on mount. INVARIANT: this is always a key that exists in
     * `options`, or null when there are no options at all — a controlled `<select>` holding a
     * value no option carries renders the first entry while the math uses something else, and
     * the next unrelated save writes that mismatch into the tax columns.
     */
    initialKey: string | null;
};

/**
 * A percent from settings JSON or from `Estimate.taxRatePercent`, which arrives as a number, as a
 * string (Prisma `Decimal` serializes that way through the RSC boundary), or as junk.
 *
 * Returns null for anything unusable. Never 0 — coercing garbage to 0 would quote the client a
 * 0% tax that nobody configured, which reads as a deliberate exemption downstream.
 */
function toFiniteRate(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "") return null;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * Drop company rows the picker cannot honestly show.
 *
 * `CompanySettings.salesTaxes` is free-form JSON: `JSON.parse` hands back `null`, `{}`, arrays
 * holding `null`, rows with a missing/`"abc"` rate, rows with a blank name. `parseSalesTaxes`
 * (src/lib/sales-tax.ts) guarantees an array of objects; this adds the per-row rules the editor
 * needs. A malformed row is DROPPED, never repaired into a 0% option — a phantom 0% row could
 * become `defaultOption` and quote the client no tax at all.
 *
 * Rates outside 0..100 are malformed and are dropped too. /settings/sales-taxes puts `min="0"
 * max="100"` on the input, but those attributes only style the spinner and gate form validation —
 * `handleAdd` is a plain click handler that reads `parseFloat(newRate)` and never consults
 * `checkValidity()`, so a typed `-5` or `8800` saves today. A negative rate bills the client a
 * discount; a 8800% rate bills them 88x the job.
 */
export function sanitizeCompanySalesTaxes(input: unknown): CompanySalesTax[] {
    if (!Array.isArray(input)) return [];
    const rows: CompanySalesTax[] = [];
    for (const row of input) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const candidate = row as Record<string, unknown>;
        const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
        // A nameless row has nothing to show in the picker and nothing to write to
        // `taxRateName`; settings requires a name to add one, so this is corrupt data.
        if (name === "") continue;
        const rate = toFiniteRate(candidate.rate);
        if (rate === null) continue;
        if (!isRepresentableTaxRate(rate)) continue;
        rows.push({
            id: typeof candidate.id === "string" ? candidate.id : undefined,
            name,
            rate,
            isDefault: candidate.isDefault === true,
        });
    }
    return rows;
}

/** A sales-tax percent the app is willing to quote. Shared by settings rows and derived rates. */
export function isRepresentableTaxRate(rate: number): boolean {
    return Number.isFinite(rate) && rate >= 0 && rate <= 100;
}

/**
 * The stored sell-side money an estimate was last saved with, as the editor's `computeSellTotals`
 * composed it. `subtotal` is the LEAF-ITEM subtotal of the stored items, not `Estimate.totalAmount`
 * minus anything.
 */
export type StoredSellMoney = {
    subtotal: number | string | null | undefined;
    totalAmount: number | string | null | undefined;
    processingFeeMarkup: number | string | null | undefined;
    /** Exempt estimates legitimately store a null rate; there is no effective rate to recover. */
    taxExempt?: boolean;
};

/** The editor's money rounding (`rm` in estimate-item-payload), duplicated to keep this module pure. */
function roundMoney(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Recover the tax rate an estimate is ALREADY being billed at, from its own stored money.
 *
 * Why this exists (Justin's ruling, round 3): when `taxRatePercent` is null the editor still
 * charges tax — `computeSellTotals` falls back to a hardcoded 8.8% — and that 8.8% is baked into
 * the stored `totalAmount`. Adopting the company default instead would silently re-quote the
 * client: at a $10,000 subtotal with a 2% processing fee the estimate reads $11,080 today, and a
 * 9.15% company default would rewrite it to $11,115. A rateless estimate keeps the tax it already
 * effectively has.
 *
 * The composition inverted here is exactly `computeSellTotals`:
 *     fee   = markup > 0 ? rm(subtotal * markup/100) : 0
 *     tax   = rm(subtotal * rate/100)
 *     total = rm(subtotal + tax + fee)
 *
 * Returns null — meaning "leave the tax columns alone" — whenever the stored money cannot name a
 * rate. The final guard is not a heuristic: a candidate is returned ONLY if re-pricing the job at
 * it reproduces the stored total to the cent. That makes "never write a rate that contradicts the
 * stored total" self-enforcing rather than a claim about the arithmetic.
 */
export function deriveEffectiveTaxRate(money: StoredSellMoney | null | undefined): number | null {
    if (!money || money.taxExempt) return null;

    const subtotal = toFiniteRate(money.subtotal);
    const total = toFiniteRate(money.totalAmount);
    // A zero or negative subtotal carries no tax at any rate, so there is no effective rate to
    // recover — and, just as importantly, nothing at risk: every candidate rate re-prices such an
    // estimate to the same total. Callers fall through to their normal selection.
    if (subtotal === null || total === null || subtotal <= 0) return null;

    const markup = toFiniteRate(money.processingFeeMarkup) ?? 0;
    const fee = markup > 0 ? roundMoney(subtotal * (markup / 100)) : 0;

    const tax = total - subtotal - fee;
    const exact = (tax / subtotal) * 100;
    if (!isRepresentableTaxRate(exact)) return null;

    // Prefer a tidy 4-dp rate (what the picker displays, and what a human would recognise) but
    // only if it still reproduces the money; otherwise keep full precision. Either way the
    // reproduction check below is the gate.
    const reproduces = (rate: number) =>
        roundMoney(subtotal + roundMoney(subtotal * (rate / 100)) + fee) === total;

    const rounded = Math.round(exact * 10_000) / 10_000;
    if (isRepresentableTaxRate(rounded) && reproduces(rounded)) return rounded;
    if (reproduces(exact)) return exact;
    return null;
}

export function buildTaxOptions(
    salesTaxes: readonly CompanySalesTax[] | null | undefined,
    saved: { name: string | null | undefined; percent: number | string | null | undefined },
    /**
     * The estimate's stored money. OPTIONAL only so the many call sites that have no money to
     * preserve (tests of the settings-side behaviour) stay readable; the editor always passes it.
     * Omitting it disables rate derivation, i.e. restores the pre-ruling "adopt the default".
     */
    storedMoney?: StoredSellMoney | null,
): TaxOptionSet {
    // Typed as CompanySalesTax[] but sourced from JSON.parse at every call site, so the shape is
    // a claim, not a guarantee. Validate at runtime rather than trusting the annotation.
    const options: TaxOption[] = sanitizeCompanySalesTaxes(salesTaxes).map((t, index) => ({
        key: companyTaxKey(index),
        name: t.name,
        label: t.name,
        rate: t.rate,
        isDefault: !!t.isDefault,
        orphaned: false,
    }));
    const defaultOption = options.find(t => t.isDefault) || options[0] || null;

    const savedName = typeof saved?.name === "string" ? saved.name : null;
    const rate = toFiniteRate(saved?.percent);

    // THE RULING (round 3): a rateless estimate keeps the tax it already effectively has. With no
    // stored rate the editor has still been charging its legacy 8.8% fallback and `totalAmount`
    // was saved WITH that tax in it, so adopting the company default would silently re-quote the
    // client. Recover the rate the stored money is actually carrying and treat that as the
    // estimate's rate. `deriveEffectiveTaxRate` returns null unless the candidate provably
    // reproduces the stored total to the cent.
    const derivedRate = rate === null ? deriveEffectiveTaxRate(storedMoney) : null;

    // The effective rate the estimate carries, from either source. Below this line the two are
    // interchangeable: both are "this estimate's own rate", and both outrank the company default.
    const ownRate = rate ?? derivedRate;

    // Settings already carry this exact name+rate PAIR, so the company option IS this estimate's
    // rate — no synthetic option needed. For a DERIVED rate the name has to match too: landing on
    // a same-named row at a different rate is the re-quoting bug, and landing on a differently
    // named row at the same rate would invent a `taxRateName` the estimate never had.
    const ownExactMatch =
        ownRate === null || savedName === null
            ? null
            : options.find(o => o.name === savedName && o.rate === ownRate) ?? null;

    const savedOption: TaxOption | null =
        ownRate === null || ownExactMatch
            ? null
            : {
                  key: SAVED_TAX_KEY,
                  // Opening the editor must not give a stored rate a name it never had.
                  name: savedName,
                  label: savedName || (derivedRate !== null ? "Estimated Tax" : "Saved rate"),
                  rate: ownRate,
                  isDefault: false,
                  orphaned: true,
              };

    // Nothing stored, nothing derivable, but there IS a subtotal whose total we must not disturb:
    // the stored money is incoherent (no total on file, or a total no rate in 0..100 explains).
    // The only safe selection writes the tax columns back exactly as they are — name preserved,
    // percent still null — and leaves the editor on its 8.8% fallback, so the save is a true
    // no-op. Never guess a rate here; a guess that misses rewrites the client's total.
    const needsUnrated = ownRate === null && hasMoneyAtRisk(storedMoney);

    const unratedOption: TaxOption | null = needsUnrated
        ? {
              key: UNRATED_TAX_KEY,
              name: savedName,
              label: savedName || "Estimated Tax",
              rate: null,
              isDefault: false,
              orphaned: true,
          }
        : null;

    // A stored NAME with no usable rate and no money at risk. The closest honest selection is the
    // company row carrying that name, which keeps `taxRateName` byte-for-byte and only fills in
    // the rate the editor was applying anyway. With no such row we fall to the company default.
    const nameOnlyMatch =
        ownRate !== null || unratedOption || savedName === null
            ? null
            : options.find(o => o.name === savedName) ?? null;

    const extra = savedOption ?? unratedOption;
    return {
        options: extra ? [...options, extra] : options,
        savedOption,
        defaultOption,
        // The estimate's own rate wins whenever it exists, so the quoted rate survives a round
        // trip through the editor untouched. Every branch yields a key that IS in `options`.
        initialKey:
            savedOption?.key ??
            ownExactMatch?.key ??
            unratedOption?.key ??
            nameOnlyMatch?.key ??
            defaultOption?.key ??
            null,
    };
}

/**
 * Is there stored money a wrong rate could damage? Only a positive stored subtotal can carry tax,
 * so anything else (a brand-new estimate with no items, a zeroed-out one) is free to take the
 * company default the way it always has — no rate choice moves its total off zero. Keeping this
 * carve-out narrow is what stops the derivation rule from regressing every new estimate into the
 * legacy 8.8% fallback.
 */
function hasMoneyAtRisk(money: StoredSellMoney | null | undefined): boolean {
    if (!money || money.taxExempt) return false;
    const subtotal = toFiniteRate(money.subtotal);
    return subtotal !== null && subtotal > 0;
}

/**
 * The rate the editor charges when no option names one. This is LEGACY: it predates the tax picker
 * and is why rateless estimates have real tax baked into `totalAmount` at all. It is not a default
 * anyone configured, so nothing may ever WRITE it to `taxRatePercent` — it only prices.
 */
export const LEGACY_FALLBACK_TAX_RATE = 8.8;

/**
 * The tax fraction to price a job at. One function so the editor's render, its `computeSellTotals`
 * and the tests cannot drift on what a null rate means.
 */
export function taxFractionFor(activeTax: TaxOption | null | undefined, taxExempt: boolean): number {
    if (taxExempt) return 0;
    // `?? LEGACY_FALLBACK`, not `|| `: a resolved rate of 0 is a real 0% and must not fall through.
    return (activeTax?.rate ?? LEGACY_FALLBACK_TAX_RATE) / 100;
}

/** Resolve the active option by KEY, falling back to the company default. */
export function resolveActiveTax(
    options: TaxOption[],
    key: string | null,
    defaultOption: TaxOption | null,
): TaxOption | null {
    return options.find(t => t.key === key) || defaultOption;
}

/** Two options quote the same thing when they write the same pair of tax columns. */
function sameTax(a: TaxOption, b: TaxOption): boolean {
    return a.name === b.name && a.rate === b.rate;
}

/**
 * Carry a selected key across a REBUILD of the option set.
 *
 * The editor seeds `selectedTaxKey` once, but the option set is rebuilt whenever fresh props
 * arrive (a settings edit in another tab, the router refresh after a save). Keys are positional,
 * so a rebuild can delete the selected key — or silently repoint it at a different tax — and
 * either way the editor would fall through to the company default and re-quote the client on the
 * next save. Identity survives as the (name, rate) pair, so that is what we re-match on.
 *
 * The last resort is `next.initialKey` (what a fresh open of this estimate would select), NOT
 * `defaultOption`: the estimate's own stored rate outranks the company default every time.
 */
export function reconcileTaxKey(
    key: string | null,
    previousOptions: readonly TaxOption[],
    next: TaxOptionSet,
): string | null {
    // A null key is "nothing selected", NOT "exempt" — exemption lives in `taxExempt` and never
    // touches this key (see the module doc). It used to short-circuit here, which meant a
    // non-exempt estimate opened against EMPTY settings (null key, no options) kept its null key
    // once settings were populated: the `<select>` rendered the first row while `resolveActiveTax`
    // fell through to `defaultOption`, and the next save wrote whichever of the two the user was
    // not looking at. Repair it like any other unusable key.
    if (key === null) return next.initialKey;

    const was = previousOptions.find(o => o.key === key) ?? null;
    if (!was) {
        // Nothing to re-match against (first run, or a key from outside this module).
        return next.options.some(o => o.key === key) ? key : next.initialKey;
    }
    // Same key AND same meaning: the common no-op path, so the user's explicit pick survives an
    // unrelated refresh.
    if (next.options.some(o => o.key === key && sameTax(o, was))) return key;

    const moved = next.options.find(o => sameTax(o, was)) ?? null;
    if (moved) return moved.key;

    return next.initialKey;
}

/**
 * The `taxRateName`/`taxRatePercent` pair a save writes. Shared by the two editor write sites
 * (the save snapshot and the delete-undo restore) so they can never disagree about what an
 * exempt estimate stores. Exempt clears BOTH columns: an exempt sale has no rate, and leaving
 * a stale percent behind would let a later un-exempt silently re-apply it.
 */
export function taxFieldsForSave(
    activeTax: TaxOption | null | undefined,
    taxExempt: boolean,
): { taxRateName: string | null; taxRatePercent: number | null } {
    if (taxExempt) return { taxRateName: null, taxRatePercent: null };
    return {
        taxRateName: activeTax?.name || null,
        // `??`, not `||`: a rate of 0 is a real rate and must survive the write.
        taxRatePercent: activeTax?.rate ?? null,
    };
}
