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
 * A stored rate of 0 is an answer (rate zero), not an absence — only null means "unset".
 */

/** Option key for the estimate's own saved rate. Reserved; a company row can never mint it. */
export const SAVED_TAX_KEY = "__saved__";

/** Option key for the picker's "Tax Exempt" entry. Reserved, same as above. */
export const EXEMPT_TAX_KEY = "__exempt__";

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
    rate: number;
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
        rows.push({
            id: typeof candidate.id === "string" ? candidate.id : undefined,
            name,
            rate,
            isDefault: candidate.isDefault === true,
        });
    }
    return rows;
}

export function buildTaxOptions(
    salesTaxes: readonly CompanySalesTax[] | null | undefined,
    saved: { name: string | null | undefined; percent: number | string | null | undefined },
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

    // Settings already carry this exact name+rate PAIR, so the company option IS the saved rate —
    // no synthetic option needed, and the picker stays a plain list of settings. Matching on the
    // name alone would hand back a same-named row at a different rate and re-quote the client.
    const exactMatch =
        rate === null || savedName === null
            ? null
            : options.find(o => o.name === savedName && o.rate === rate) ?? null;

    const savedOption: TaxOption | null =
        rate === null || exactMatch
            ? null
            : {
                  key: SAVED_TAX_KEY,
                  // Opening the editor must not give a stored rate a name it never had.
                  name: savedName,
                  label: savedName || "Saved rate",
                  rate,
                  isDefault: false,
                  orphaned: true,
              };

    // A stored NAME with no usable rate is not a quote — there is no money to preserve, and no
    // option can write `{ name, percent: null }` without leaving `totalAmount` (which already
    // includes the fallback rate) contradicting the columns. The closest honest selection is the
    // company row carrying that name, which keeps `taxRateName` byte-for-byte and only fills in
    // the rate the editor was applying anyway. With no such row we fall to the company default:
    // same money, and the columns stop lying about it.
    const nameOnlyMatch =
        rate !== null || savedName === null
            ? null
            : options.find(o => o.name === savedName) ?? null;

    return {
        options: savedOption ? [...options, savedOption] : options,
        savedOption,
        defaultOption,
        // The saved rate wins whenever it exists, so the quoted rate survives a round trip
        // through the editor untouched. Every branch yields a key that IS in `options`.
        initialKey: savedOption?.key ?? exactMatch?.key ?? nameOnlyMatch?.key ?? defaultOption?.key ?? null,
    };
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
    // null is the picker's "Tax Exempt" state, not a stale key.
    if (key === null) return null;

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
