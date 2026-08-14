/**
 * The company's configured sales-tax table (`CompanySettings.salesTaxes`), read in one place.
 *
 * The table is stored as a JSON string of `{ name, rate, isDefault }` rows, edited at
 * /settings/sales-taxes. Several callers used to parse it themselves; the AI takeoff prompt did not
 * read it at all and hardcoded 8.4%, so every AI-generated estimate quoted the client a rate the
 * rest of the app disagreed with (production's configured default is 8.8%).
 *
 * `rate` is a PERCENT (8.8 means 8.8%), matching `Estimate.taxRatePercent`.
 */

export type ConfiguredSalesTax = { name?: string; rate?: number; isDefault?: boolean };

/** Parse the stored JSON into rows. Anything unparseable or non-array reads as "none configured". */
export function parseSalesTaxes(raw: string | null | undefined): ConfiguredSalesTax[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        // JSON.parse("null") and JSON.parse("{}") both succeed without being an array, and a
        // subsequent .find/.filter would throw at the call site.
        return Array.isArray(parsed) ? (parsed as ConfiguredSalesTax[]) : [];
    } catch {
        return [];
    }
}

/** The row marked default, else the first configured row, else null. */
export function pickDefaultSalesTax(taxes: ConfiguredSalesTax[]): ConfiguredSalesTax | null {
    if (!Array.isArray(taxes) || taxes.length === 0) return null;
    return taxes.find((t) => t?.isDefault) || taxes[0] || null;
}

/**
 * The company's default sales tax, or null when none is configured / the stored row carries no
 * usable rate. A null here means "we have no rate to apply", which is NOT the same as a configured
 * rate of 0 (an explicit "this company does not charge sales tax") — but both currently lead every
 * caller to the same place: don't apply tax. Callers that must tell them apart should read the row.
 */
export async function getDefaultSalesTax(): Promise<{ name: string | null; rate: number } | null> {
    // Imported lazily so the pure parsing helpers above stay importable (and unit-testable) without
    // instantiating a Prisma client.
    const { prisma } = await import("./prisma");
    const settings = await prisma.companySettings.findUnique({
        where: { id: "singleton" },
        select: { salesTaxes: true },
    });
    const def = pickDefaultSalesTax(parseSalesTaxes(settings?.salesTaxes));
    if (!def) return null;
    if (typeof def.rate !== "number" || !Number.isFinite(def.rate)) return null;
    const name = typeof def.name === "string" && def.name.trim() !== "" ? def.name.trim() : null;
    return { name, rate: def.rate };
}

/**
 * The default sales tax rate as a percent, or 0 when none is configured.
 *
 * Kept as a distinct helper because the approval gross-up in actions.ts treats 0 as "don't gross
 * up" and has no use for the name.
 */
export async function getDefaultSalesTaxRate(): Promise<number> {
    const def = await getDefaultSalesTax();
    return def?.rate ?? 0;
}
