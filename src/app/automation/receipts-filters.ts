/**
 * Pure parsing + predicates for the Receipts tab's URL filters — kept out of
 * `page.tsx` (an async Server Component, not import-safe for a plain unit
 * test) for exactly the reason `register-filters.ts` exists.
 */
import type { ReceiptOwner } from "@/lib/receipt-policy";

export const RECEIPT_GROUPS = [
    "needs-job",
    "needs-review",
    "booking",
    "booked-today",
    "missing-receipts",
    "duplicates",
] as const;

export type ReceiptGroup = (typeof RECEIPT_GROUPS)[number];

export const RECEIPT_GROUP_LABELS: Record<ReceiptGroup, string> = {
    "needs-job": "Needs job",
    "needs-review": "Needs review",
    booking: "Booking",
    "booked-today": "Booked today",
    "missing-receipts": "Missing receipts",
    duplicates: "Duplicates",
};

/**
 * Owner display order for the missing-receipt sub-groups: the people who are
 * actually asked come first. `unassigned` sorts last but is never dropped —
 * an unrecognized card tail has to stay visible, not vanish into a bucket
 * nobody looks at.
 */
export const OWNER_ORDER: ReceiptOwner[] = ["CJ", "Richard", "office", "Justin", "unassigned"];

export function ownerRank(owner: string): number {
    const index = OWNER_ORDER.indexOf(owner as ReceiptOwner);
    return index === -1 ? OWNER_ORDER.length : index;
}

export interface ReceiptFilters {
    /** null = show every group. */
    group: ReceiptGroup | null;
    projectId: string | null;
    owner: string | null;
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
    return { group, projectId: firstParam(sp.projectId), owner };
}

/** True when a group should be rendered at all under the current filters. */
export function groupIsVisible(group: ReceiptGroup, filters: ReceiptFilters): boolean {
    return filters.group === null || filters.group === group;
}

/**
 * `projectId` narrows intake rows. A row with NO project still passes when no
 * project filter is set — "Needs job" is precisely the group of rows without
 * one, and a filter that hid them would make the group unusable.
 */
export function intakeMatchesFilters<T extends { projectId: string | null }>(row: T, filters: ReceiptFilters): boolean {
    if (filters.projectId !== null && row.projectId !== filters.projectId) return false;
    return true;
}

/** `owner` narrows missing-receipt rows; `projectId` never does (a bank line has no job yet). */
export function missingReceiptMatchesFilters<T extends { owner: string }>(row: T, filters: ReceiptFilters): boolean {
    if (filters.owner !== null && row.owner !== filters.owner) return false;
    return true;
}
