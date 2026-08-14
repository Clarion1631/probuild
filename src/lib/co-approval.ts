// Shared change-order manual-approval provenance rule, mirroring co-tax.ts's
// shape: single source of truth, client-safe (no prisma, pure functions), used
// by change-order-core (writes the marker), billing-core (suppresses the
// client-facing milestone email and picks team-email wording), the portal
// change-order page, and the CO PDF (both read the marker back to render
// honest copy instead of implying the client signed).
//
// The check is DB-derived rather than a passed-in flag on purpose: a CO is a
// manual approval if and only if it is Approved with no clientSignatureUrl and
// approvedBy carries this suffix — true no matter which code path (the inline
// after() callback, the hourly cron backstop, a future caller) reads the row.

export const MANUAL_CO_APPROVAL_SUFFIX = " (manual approval — staff)";

export type ManualApprovalCoFields = {
    clientSignatureUrl?: string | null;
    approvedBy?: string | null;
};

export function isManualCoApproval(co: ManualApprovalCoFields | null | undefined): boolean {
    return !!co && !co.clientSignatureUrl && !!co.approvedBy && co.approvedBy.endsWith(MANUAL_CO_APPROVAL_SUFFIX);
}

/** Strips the marker suffix back off, e.g. for "Jane Doe (manual approval — staff)" -> "Jane Doe". */
export function staffNameFromManualApprovedBy(approvedBy: string | null | undefined): string {
    if (!approvedBy) return "";
    return approvedBy.endsWith(MANUAL_CO_APPROVAL_SUFFIX)
        ? approvedBy.slice(0, -MANUAL_CO_APPROVAL_SUFFIX.length)
        : approvedBy;
}
