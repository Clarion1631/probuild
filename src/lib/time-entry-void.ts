import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

/** Operational readers only. Ownership, lock, deletion and audit readers retain voids. */
export function nonVoidedTimeEntryWhere(where: Prisma.TimeEntryWhereInput = {}): Prisma.TimeEntryWhereInput {
    return { AND: [{ voidedAt: null }, where] };
}
export class TimeEntryVoidError extends Error {
    constructor(message: string, public status = 409, public code = "TIME_ENTRY_VOIDED") { super(message); }
}
export function validateVoidRequest(role: string, input: unknown) {
    if (role !== "ADMIN" && role !== "MANAGER") throw new TimeEntryVoidError("Only managers can void time entries", 403, "FORBIDDEN");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TimeEntryVoidError("Invalid request", 400, "INVALID_VOID_REQUEST");
    const body = input as { reason?: unknown; expectedUpdatedAt?: unknown };
    if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000) throw new TimeEntryVoidError("A reason of 1–1000 characters is required", 400, "INVALID_VOID_REQUEST");
    if (typeof body.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) throw new TimeEntryVoidError("The entry version is required. Refresh and try again.", 400, "INVALID_VOID_REQUEST");
    return { reason: body.reason.trim(), expectedUpdatedAt: new Date(body.expectedUpdatedAt) };
}
export function assertVoidableTimeEntry(row: { invoiceId: unknown; invoicedAt: unknown; qbTimeActivityId: unknown; qbSyncedAt: unknown }) {
    if (row.invoiceId || row.invoicedAt || row.qbTimeActivityId || row.qbSyncedAt) throw new TimeEntryVoidError("This entry is linked to billing or QuickBooks. Review its reversal before voiding.", 409, "TIME_ENTRY_LINKED");
}
export function isTimeEntryVoidedError(error: unknown) {
    return error instanceof TimeEntryVoidError || /TIME_ENTRY_VOIDED/.test(String((error as { message?: unknown })?.message ?? ""));
}
export function timeEntryVoidedResponse() {
    return NextResponse.json({ error: "This entry was voided and cannot be changed.", code: "TIME_ENTRY_VOIDED" }, { status: 409 });
}
