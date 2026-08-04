/**
 * Pure register-table row filtering — kept separate from `page.tsx` (an
 * async Server Component, not import-safe for a plain unit test) so the
 * filter predicate itself is directly testable.
 */
export interface RegisterFilterOptions {
    type: "all" | "in" | "out";
    reviewOnly: boolean;
    /** True when documentation/review status couldn't be loaded for this
     * render (`mergeUnavailable` in page.tsx) — every row's `needsReview` is
     * then a fabricated `false`, NOT "reviewed and clean". Applying the
     * "needs review only" filter against that fabricated data would remove
     * every row and render an empty "nothing here" state that reads as "all
     * clear" instead of "we don't know" — so the filter is ignored (all rows
     * pass) whenever this is true. */
    mergeUnavailable: boolean;
}

export function applyRegisterFilters<T extends { amountCents: number; needsReview: boolean }>(
    rows: T[],
    options: RegisterFilterOptions,
): T[] {
    return rows.filter((row) => {
        if (options.reviewOnly && !options.mergeUnavailable && !row.needsReview) return false;
        if (options.type === "in") return row.amountCents > 0;
        if (options.type === "out") return row.amountCents < 0;
        return true;
    });
}
