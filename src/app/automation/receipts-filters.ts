/**
 * Pure parsing + predicates for the Receipts tab's URL filters — kept out of
 * `page.tsx` (an async Server Component, not import-safe for a plain unit
 * test) for exactly the reason `register-filters.ts` exists.
 */
import type { ReceiptOwner } from "@/lib/receipt-policy";

/**
 * Per-group display cap. Badge counts come from count queries, never from
 * these lists.
 *
 * It lives HERE, in the pure module, rather than beside the queries that use
 * it: the To-do planner has to know when a loaded group hit the cap (a full
 * page is a window, not an inbox), and it is a pure function that must not
 * drag Prisma into a unit test to find out. `receipts-data.ts` re-exports it,
 * so every existing import path is unchanged.
 */
export const RECEIPT_GROUP_TAKE = 100;

/**
 * The Set job list's cap. Folder suggestions are off at the cap, because a
 * cut list can fake a single match.
 */
export const JOB_OPTIONS_TAKE = 200;

export const RECEIPT_GROUPS = [
    "needs-job",
    "needs-review",
    "booking",
    "booked-today",
    "missing-receipts",
    "duplicates",
    "exceptions",
    "uncertain-cards",
] as const;

export type ReceiptGroup = (typeof RECEIPT_GROUPS)[number];

/**
 * Which SHAPE of the tab a bare `?tab=receipts` draws. Beside `group` rather
 * than overloading `group: null`, so every link that exists today keeps
 * resolving to what it resolved to before: a `?group=` URL still renders that
 * one group, and `?view=all` is a real, bookmarkable name for the old default.
 */
export const RECEIPT_VIEWS = ["todo", "all"] as const;

export type ReceiptView = (typeof RECEIPT_VIEWS)[number];

export const RECEIPT_GROUP_LABELS: Record<ReceiptGroup, string> = {
    "needs-job": "Needs job",
    "needs-review": "Needs review",
    booking: "Booking",
    "booked-today": "Booked today",
    "missing-receipts": "Missing receipts",
    duplicates: "Duplicates",
    exceptions: "Exceptions",
    "uncertain-cards": "Uncertain deliveries",
};

/**
 * Owner display order for the missing-receipt sub-groups: the people who are
 * actually asked come first, then `unattributed` — charges with no card tail
 * and no office rail, which a human has to attribute before a card can go out.
 * It sits third BECAUSE it is work: burying it under office/Justin is how it
 * would never get done. `unassigned` sorts last but is never dropped — an
 * unrecognized card tail has to stay visible, not vanish into a bucket nobody
 * looks at.
 */
export const OWNER_ORDER: ReceiptOwner[] = ["CJ", "Richard", "unattributed", "office", "Justin", "unassigned"];

export function ownerRank(owner: string): number {
    const index = OWNER_ORDER.indexOf(owner as ReceiptOwner);
    return index === -1 ? OWNER_ORDER.length : index;
}

export interface ReceiptFilters {
    /** null = show every group. */
    group: ReceiptGroup | null;
    projectId: string | null;
    owner: string | null;
    /**
     * OPTIONAL on purpose. `parseReceiptFilters` always sets it, so no URL ever
     * reaches a render without one. A filter object built by hand that omits it
     * is the pre-To-do shape and draws exactly what it drew before, which is
     * what keeps the existing render tests honest pins rather than rewrites.
     */
    view?: ReceiptView;
}

function firstParam(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value[0] ?? null;
    return typeof value === "string" && value !== "" ? value : null;
}

/** Never trusts the query string: an unrecognized group/owner falls back to "all". */
export function parseReceiptFilters(sp: Record<string, string | string[] | undefined>): ReceiptFilters {
    const rawGroup = firstParam(sp.group);
    const group = RECEIPT_GROUPS.includes(rawGroup as ReceiptGroup) ? (rawGroup as ReceiptGroup) : null;
    const rawOwner = firstParam(sp.owner);
    const owner = rawOwner !== null && OWNER_ORDER.includes(rawOwner as ReceiptOwner) ? rawOwner : null;
    // A URL that ASKED for a group or an owner and named one this page does not
    // know still means "show me the groups". It fell back to the all-groups
    // view before the To-do view existed, and bouncing it somewhere new is a
    // behaviour change hiding inside a typo.
    const askedForGroups = ("group" in sp && group === null) || ("owner" in sp && owner === null);
    const rawView = firstParam(sp.view);
    const view = rawView === null && askedForGroups
        ? "all"
        : RECEIPT_VIEWS.includes(rawView as ReceiptView) ? (rawView as ReceiptView) : "todo";
    return { group, projectId: firstParam(sp.projectId), owner, view };
}

/**
 * Does this URL draw Marge's To-do list?
 *
 * Only a bare `?tab=receipts` does. A `group` is a request for one group and an
 * `owner` is a request to narrow by person, and the To-do view does neither, so
 * either one falls back to the view that can honour it. That is also what keeps
 * every bookmark anyone already has pointing at the same page it always did.
 */
export function showsTodoView(filters: ReceiptFilters): boolean {
    return filters.group === null && filters.owner === null && filters.view === "todo";
}

/**
 * The Receipts tab's URL builder: one chip, one folded line, one link.
 *
 * Exported so the page and its tests use the SAME function. A copy in a test
 * proves the copy works, which is not the question anyone was asking.
 *
 * `view` rides along with group and owner so a link keeps whatever shape the
 * reader is already in. "todo" is the default and is never written to the URL,
 * which is what leaves `?tab=receipts&group=needs-job` byte for byte the link
 * it has always been.
 */
export function receiptFilterHref(
    filters: ReceiptFilters,
    overrides: { group?: string; owner?: string; view?: string },
): string {
    const params = new URLSearchParams();
    params.set("tab", "receipts");
    const nextGroup = overrides.group ?? filters.group ?? "";
    const nextOwner = overrides.owner ?? filters.owner ?? "";
    const nextView = overrides.view ?? filters.view ?? "";
    if (nextGroup) params.set("group", nextGroup);
    if (nextOwner) params.set("owner", nextOwner);
    if (filters.projectId) params.set("projectId", filters.projectId);
    if (nextView && nextView !== "todo") params.set("view", nextView);
    return `/automation?${params.toString()}`;
}

/** True when a group should be rendered at all under the current filters. */
export function groupIsVisible(group: ReceiptGroup, filters: ReceiptFilters): boolean {
    return filters.group === null || filters.group === group;
}

/**
 * `owner` narrows missing-receipt rows; `projectId` never does, because a bank
 * line has no job yet — applying the project filter here would silently empty
 * the group whenever someone drilled into a job.
 *
 * Intake rows are narrowed by `projectId` in the QUERY instead of here, so the
 * badge counts and the capped lists agree. There is deliberately no in-memory
 * twin of that predicate: a second copy is how a list and its count start
 * disagreeing.
 */
export function missingReceiptMatchesFilters<T extends { owner: string }>(row: T, filters: ReceiptFilters): boolean {
    if (filters.owner !== null && row.owner !== filters.owner) return false;
    return true;
}
