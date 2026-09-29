import { classifyCalendarDate, dateOnlyInTimeZone, dayKeyInTimeZone } from "./tz-date";

/**
 * Pure helpers for the office-side "Mark approved" flow (customer approved a
 * change order by phone, text, email, or in person). No Prisma or server-only
 * imports, so the editor can import them and tests can run hermetically.
 */

export const OFFLINE_APPROVAL_SOURCE = "OFFLINE";
export const OFFLINE_APPROVAL_NOTE_MAX = 1000;

export type OfflineApprovalMethod = "PHONE" | "TEXT" | "EMAIL" | "IN_PERSON" | "OTHER";

export const OFFLINE_APPROVAL_METHODS: ReadonlyArray<{ value: OfflineApprovalMethod; label: string; phrase: string }> = [
    { value: "PHONE", label: "Phone", phrase: "by phone" },
    { value: "TEXT", label: "Text", phrase: "by text" },
    { value: "EMAIL", label: "Email", phrase: "by email" },
    { value: "IN_PERSON", label: "In person", phrase: "in person" },
    { value: "OTHER", label: "Other", phrase: "other" },
];

export function isOfflineApproval(co: { approvalSource?: string | null } | null | undefined): boolean {
    return co?.approvalSource === OFFLINE_APPROVAL_SOURCE;
}

export function offlineApprovalMethodPhrase(method: string | null | undefined): string {
    return OFFLINE_APPROVAL_METHODS.find((row) => row.value === method)?.phrase ?? "other";
}

export class OfflineApprovalInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OfflineApprovalInputError";
    }
}

export function parseOfflineApprovalInput(
    raw: { method: unknown; approvedOn: unknown; note?: unknown },
    ctx: { now: Date; timeZone: string },
): { method: OfflineApprovalMethod; approvedOn: string; approvedAt: Date; note: string | null } {
    const method = OFFLINE_APPROVAL_METHODS.find((row) => row.value === raw.method)?.value;
    if (!method) throw new OfflineApprovalInputError("Choose how the customer approved.");

    const verdict = classifyCalendarDate(raw.approvedOn);
    if (verdict.kind !== "valid") throw new OfflineApprovalInputError("Enter a valid approval date.");
    const approvedOn = verdict.date;
    if (approvedOn > dayKeyInTimeZone(ctx.now, ctx.timeZone)) {
        throw new OfflineApprovalInputError("The approval date can't be in the future.");
    }

    let note: string | null = null;
    if (raw.note !== undefined && raw.note !== null) {
        if (typeof raw.note !== "string") throw new OfflineApprovalInputError("The note must be text.");
        const trimmed = raw.note.trim();
        if (trimmed.length > OFFLINE_APPROVAL_NOTE_MAX) {
            throw new OfflineApprovalInputError(`The note can be at most ${OFFLINE_APPROVAL_NOTE_MAX} characters.`);
        }
        note = trimmed === "" ? null : trimmed;
    }

    return { method, approvedOn, approvedAt: dateOnlyInTimeZone(approvedOn, ctx.timeZone), note };
}

export function formatOfflineApprovalDate(value: Date | string | null | undefined, timeZone: string): string {
    const when = value ? new Date(value) : null;
    return when && !Number.isNaN(when.getTime())
        ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(when)
        : "an earlier date";
}

/** "Approved by {name} on {Mon D, YYYY} ({method phrase})", date in the company time zone. */
export function offlineApprovalSummary(
    co: { approvedBy?: string | null; approvedAt?: Date | string | null; approvalMethod?: string | null },
    timeZone: string,
): string {
    const name = co.approvedBy?.trim() || "the office";
    const date = formatOfflineApprovalDate(co.approvedAt, timeZone);
    return `Approved by ${name} on ${date} (${offlineApprovalMethodPhrase(co.approvalMethod)})`;
}

/**
 * Prisma fragment for reminder selection: keep a milestone unless it came from
 * an offline-approved change order AND has never been requested. Null-safe:
 * an ordinary milestone (sourceChangeOrderId NULL) must still match.
 * Returns undefined when there are no offline change orders.
 */
export function offlineHoldMilestoneWhere(offlineCoIds: readonly string[]) {
    if (offlineCoIds.length === 0) return undefined;
    const ids = [...offlineCoIds];
    return {
        OR: [
            { sourceChangeOrderId: null },
            { sourceChangeOrderId: { notIn: ids } },
            { qbInvoiceSentAt: { not: null } },
        ],
    };
}
