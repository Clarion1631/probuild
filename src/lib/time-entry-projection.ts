// What a TimeEntry response is allowed to contain, per audience.
//
// GET /api/time-entries used to serialize the whole Prisma model plus
// `user: true` — the entry's OWNER as a complete User row. Field crew therefore
// received, for their own entries, their `pinCode` BCRYPT HASH, their
// `hourlyRate`, `burdenRate` and `payType`; and a MANAGER, whose query is not
// scoped to themselves, received that for every person in the company
// (round 8, finding 1). A password-equivalent hash has no audience at all, and
// pay data has a narrow one.
//
// Everything here is an ALLOWLIST, not a delete-list. A denylist is wrong the
// moment a column is added: the next `ssn`, `bankAccount` or token column would
// ship to the crew app by default, silently, because nobody remembered to add
// it to a filter. A column has to be named here to be returned.

/**
 * The operational shape of a punch: what it is, when it was, where, and every
 * flag the crew app and the manager queue render.
 *
 * Money is deliberately absent — see TIME_ENTRY_PAY_SELECT.
 */
export const TIME_ENTRY_CREW_SELECT = {
    id: true,
    voidedAt: true,
    voidedById: true,
    voidReason: true,
    userId: true,
    projectId: true,
    costCodeId: true,
    costTypeId: true,
    estimateItemId: true,
    scheduleTaskId: true,
    changeOrderId: true,
    isBillable: true,

    startTime: true,
    endTime: true,
    durationHours: true,
    shiftHours: true,

    latitude: true,
    longitude: true,
    offsiteMs: true,
    isOffsite: true,
    lastLocationCheck: true,

    notes: true,
    rawNote: true,
    formalizedNote: true,
    logisticsCategory: true,
    routedFromProjectId: true,
    routedAt: true,
    routedById: true,

    // WA break model — hours, not money, and the worker is entitled to see
    // what was deducted from their own shift.
    mealSkipped: true,
    mealDeductionHours: true,
    mealOutcome: true,
    restBreaksMissed: true,
    mealSkipRequestedAt: true,
    mealSkipStatus: true,
    mealSkipDecidedById: true,
    mealSkipDecidedAt: true,
    mealSkipReason: true,

    needsReview: true,
    reviewReason: true,

    isEdited: true,
    originalStartTime: true,
    originalEndTime: true,
    editNotes: true,
    editedByManagerId: true,
    editedAt: true,

    suggestedScheduleTaskId: true,
    suggestedCostCodeId: true,
    suggestedTaskName: true,
    suggestionSource: true,
    suggestionOverridden: true,

    createdAt: true,
    updatedAt: true,
} as const;

/**
 * The money and the billing/sync linkage. Added only for a viewer who may read
 * financial reports — ADMIN, MANAGER, or FINANCE with the `financialReports`
 * permission, the same gate the payroll export and the rates panel use.
 */
export const TIME_ENTRY_PAY_SELECT = {
    laborCost: true,
    burdenCost: true,
    invoiceId: true,
    invoicedAt: true,
    qbTimeActivityId: true,
} as const;

/**
 * The entry's OWNER, as much of them as the audience may see.
 *
 * `pinCode` appears in NEITHER, at any tier. It is a bcrypt hash of a login
 * credential; there is no reader of this endpoint who needs it, and "only
 * managers can see it" is not a reason to serialize a password equivalent.
 */
export const TIME_ENTRY_OWNER_CREW_SELECT = { id: true, name: true } as const;

export const TIME_ENTRY_OWNER_PAY_SELECT = {
    id: true,
    name: true,
    email: true,
    role: true,
    hourlyRate: true,
    burdenRate: true,
    payType: true,
} as const;

/** The entry's own columns for one audience, WITHOUT the owner relation — for routes that return a bare entry. */
export function timeEntryScalarSelect(includePay: boolean) {
    return { ...TIME_ENTRY_CREW_SELECT, ...(includePay ? TIME_ENTRY_PAY_SELECT : {}) };
}

/** The Prisma `select` for one audience. `includePay` is the financialReports answer. */
export function timeEntrySelect(includePay: boolean) {
    return {
        ...TIME_ENTRY_CREW_SELECT,
        ...(includePay ? TIME_ENTRY_PAY_SELECT : {}),
        user: { select: includePay ? TIME_ENTRY_OWNER_PAY_SELECT : TIME_ENTRY_OWNER_CREW_SELECT },
    };
}

/**
 * Every key this endpoint can ever return, for a test to assert an allowlist
 * against rather than hunting for known-bad names. A denylist test passes for
 * every field nobody has thought of yet.
 */
export function timeEntryResponseKeys(includePay: boolean): string[] {
    return Object.keys(timeEntrySelect(includePay)).sort();
}

/**
 * Project an entry-shaped object that is ALREADY IN HAND.
 *
 * The read cannot always be narrowed: the clock-out handler decides what to
 * write from `startTime`, `endTime`, `mealSkipStatus` and the owner's rates, so
 * its reads are deliberately whole rows. The leak was never the read — it was
 * handing that row straight to `NextResponse.json`. POST returned the created
 * row verbatim, the successful clock-out returned the settled row, and both
 * ALREADY_CLOCKED_OUT conflict bodies embedded one, so crew received laborCost,
 * burdenCost, the invoice linkage and the QuickBooks activity id every time they
 * clocked out (round 9, finding 2).
 *
 * So the projection is applied at the RESPONSE boundary instead, over the same
 * allowlist the `select` uses. One function for every exit, which is what makes
 * the tripwire in tests/time-entry-response-tripwire.test.ts able to insist
 * that no route hands a raw row to a client.
 *
 * Null-tolerant: several conflict bodies carry `entry: null` when the row has
 * vanished, and that is a legitimate answer rather than something to project.
 */
export function serializeTimeEntry<T extends Record<string, unknown>>(
    entry: T | null | undefined,
    includePay: boolean
): Record<string, unknown> | null {
    if (!entry) return null;
    const allowed = new Set(Object.keys(timeEntryScalarSelect(includePay)));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
        if (allowed.has(key)) out[key] = value;
    }
    // Relations a caller may have included. Projected the same way rather than
    // passed through: `user` is where the owner's PIN hash and pay rates live.
    if (entry.user && typeof entry.user === "object") {
        const ownerAllowed = new Set(
            Object.keys(includePay ? TIME_ENTRY_OWNER_PAY_SELECT : TIME_ENTRY_OWNER_CREW_SELECT)
        );
        const owner: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(entry.user as Record<string, unknown>)) {
            if (ownerAllowed.has(key)) owner[key] = value;
        }
        out.user = owner;
    }
    for (const relation of ["project", "costCode"] as const) {
        if (entry[relation] !== undefined) out[relation] = entry[relation];
    }
    return out;
}

/** The same, JSON-safe (Decimal and Date through the same round trip every response here uses). */
export function serializeTimeEntryJson(
    entry: Record<string, unknown> | null | undefined,
    includePay: boolean
): unknown {
    return JSON.parse(JSON.stringify(serializeTimeEntry(entry, includePay)));
}
