/**
 * Sales-tax option resolution for the estimate editor.
 *
 * The editor picks a rate from a list built out of two sources: the company's configured
 * `CompanySettings.salesTaxes`, and the estimate's OWN stored `taxRateName`/`taxRatePercent`.
 * The second one exists because a save rewrites `taxRateName`, `taxRatePercent` and
 * `totalAmount` from whichever option is active — so if the editor can't resolve the rate the
 * estimate was quoted at, the first save silently re-quotes the client at the company default.
 *
 * Identity here is the option `key`, never the display name. Resolving by name loses in two
 * ways that both cost real money:
 *   - the stored name COLLIDES with a company tax at a different rate, so a by-name lookup
 *     returns the company entry and the stored rate becomes unreachable. This is the common
 *     case, not the exotic one: `api/takeoffs/convert-to-estimate` stores the literal name
 *     "Sales Tax" for any derived rate it could not uniquely match to settings.
 *   - the rate was stored with no name at all (legacy and API writers), so there is nothing
 *     to look up by.
 *
 * A stored rate of 0 is an answer (rate zero), not an absence — only null means "unset".
 */

/** Option key for the estimate's own saved rate. Company taxes key on their name. */
export const SAVED_TAX_KEY = "__saved__";

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
    /** What the editor should select on mount. */
    initialKey: string | null;
};

export function buildTaxOptions(
    salesTaxes: CompanySalesTax[],
    saved: { name: string | null | undefined; percent: number | string | null | undefined },
): TaxOptionSet {
    const options: TaxOption[] = salesTaxes.map(t => ({
        key: t.name,
        name: t.name,
        label: t.name,
        rate: Number(t.rate),
        isDefault: !!t.isDefault,
        orphaned: false,
    }));
    const defaultOption = options.find(t => t.isDefault) || options[0] || null;

    const savedName = saved.name ?? null;
    const savedPct = saved.percent;
    const rate = savedPct == null ? NaN : Number(savedPct);
    // Settings already carry this exact name+rate pair, so the company option IS the saved
    // rate — no synthetic option needed, and the picker stays a plain list of settings.
    const coveredBySettings =
        !!savedName && salesTaxes.some(t => t.name === savedName && Number(t.rate) === rate);

    const savedOption: TaxOption | null =
        savedPct == null || !Number.isFinite(rate) || coveredBySettings
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

    return {
        options: savedOption ? [...options, savedOption] : options,
        savedOption,
        defaultOption,
        // The saved rate wins whenever it exists, so the quoted rate survives a round trip
        // through the editor untouched.
        initialKey: savedOption ? SAVED_TAX_KEY : (savedName ?? defaultOption?.name ?? null),
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
