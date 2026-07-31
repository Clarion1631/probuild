// Pure planning helpers for AiSortReviewModal's Apply flow (Codex review,
// new-categories follow-up — issue 4b). Extracted out of the modal so the
// dedupe-then-resolve-then-apply logic can be unit tested without a DOM,
// React, or a live createDecisionForSuggestion call — no prisma, no
// "server-only", no React import: safe to import from the client modal AND
// from a plain Playwright/verifier script, mirroring the core/apply-core
// split used elsewhere in this feature.
//
// Also closes a __proto__-pollution gap (Codex review issue 3): the modal
// previously grouped chosen new-category names in a plain string-keyed
// object — a category literally named "__proto__" would silently collide
// with Object.prototype and the create-resolution lookup for that row would
// fail. Every name -> id/result mapping here is a Map instead.

/** Sentinel prefix for the review modal's "Create <name>" select option —
 * distinguishes an unresolved new-category choice from a real decisionId
 * without needing a second piece of per-row state. */
const NEW_CATEGORY_PREFIX = "__new_category__:";

export function newCategoryOptionValue(name: string): string {
    return `${NEW_CATEGORY_PREFIX}${name}`;
}

export function parseNewCategoryOptionValue(value: string): string | null {
    return value.startsWith(NEW_CATEGORY_PREFIX) ? value.slice(NEW_CATEGORY_PREFIX.length) : null;
}

export type NewCategoryRowPlan =
    | { kind: "leave" }
    | { kind: "decision"; decisionId: string }
    | { kind: "newCategory"; name: string };

export type ResolveNewCategoryPlanResult = {
    // normalize(name) -> the first raw (un-normalized) name seen for that
    // key. createDecisionForSuggestion is called ONCE per entry here — two
    // rows selecting "Backsplash" and " backsplash " (different raw text,
    // same normalized key) must resolve to exactly one create call, keyed
    // the SAME way the server's own dedupe (normalizeForDedupe) compares.
    uniqueNewCategoryNames: Map<string, string>;
    rowPlans: Map<string, NewCategoryRowPlan>;
};

/**
 * Pure planning step for Apply: for each row, decide whether it's left
 * unsorted, targets a real decisionId directly, or targets an unresolved
 * "Create <name>" choice — and de-duplicates the new-category names that
 * actually need resolving. Takes `normalize` as a parameter (rather than
 * importing normalizeForDedupe itself) so the caller controls exactly which
 * comparison is used; the modal passes the same normalizeForDedupe the
 * server uses (decision-template-core.ts), so a client-side grouping
 * decision can never diverge from the server's own dedupe.
 */
export function resolveNewCategoryPlan(
    rows: { itemId: string }[],
    selections: Record<string, string>,
    normalize: (name: string) => string,
): ResolveNewCategoryPlanResult {
    const uniqueNewCategoryNames = new Map<string, string>();
    const rowPlans = new Map<string, NewCategoryRowPlan>();

    for (const row of rows) {
        const raw = selections[row.itemId];
        if (!raw) {
            rowPlans.set(row.itemId, { kind: "leave" });
            continue;
        }
        const newCategoryName = parseNewCategoryOptionValue(raw);
        if (newCategoryName === null) {
            rowPlans.set(row.itemId, { kind: "decision", decisionId: raw });
            continue;
        }
        rowPlans.set(row.itemId, { kind: "newCategory", name: newCategoryName });
        const key = normalize(newCategoryName);
        if (!uniqueNewCategoryNames.has(key)) {
            uniqueNewCategoryNames.set(key, newCategoryName);
        }
    }

    return { uniqueNewCategoryNames, rowPlans };
}

export type NewCategoryResolution = { decisionId: string } | { error: string };

export type RowApplyPlan =
    | { kind: "leave" }
    | { kind: "apply"; decisionId: string }
    | { kind: "failed"; message: string };

/**
 * Combines the planning step's per-row plan with the (already-awaited)
 * per-name create results into a final per-row instruction. A category
 * create failure marks every row that depended on it as failed WITHOUT
 * attempting applySuggestedDecision for them — rows depending on a
 * DIFFERENT (independent) name are unaffected and still get an "apply"
 * instruction.
 */
export function buildRowApplyPlans(
    rows: { itemId: string }[],
    plan: ResolveNewCategoryPlanResult,
    normalize: (name: string) => string,
    resolutions: Map<string, NewCategoryResolution>,
): Map<string, RowApplyPlan> {
    const result = new Map<string, RowApplyPlan>();
    for (const row of rows) {
        const rowPlan = plan.rowPlans.get(row.itemId);
        if (!rowPlan || rowPlan.kind === "leave") {
            result.set(row.itemId, { kind: "leave" });
            continue;
        }
        if (rowPlan.kind === "decision") {
            result.set(row.itemId, { kind: "apply", decisionId: rowPlan.decisionId });
            continue;
        }
        // newCategory — resolve via the SAME normalized key it was grouped
        // under in resolveNewCategoryPlan.
        const key = normalize(rowPlan.name);
        const resolution = resolutions.get(key);
        if (!resolution) {
            // Defensive only — every key in plan.uniqueNewCategoryNames is
            // expected to have a resolution by the time this runs.
            result.set(row.itemId, { kind: "failed", message: "Couldn't create category" });
            continue;
        }
        if ("error" in resolution) {
            result.set(row.itemId, { kind: "failed", message: resolution.error });
            continue;
        }
        result.set(row.itemId, { kind: "apply", decisionId: resolution.decisionId });
    }
    return result;
}
