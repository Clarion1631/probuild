/**
 * Late job/phase assignment on an intake row.
 *
 * A forwarder often knows the bytes before it knows the job: Drive files land
 * in a project folder, mobile captures pick a job on the next screen, and a
 * replayed finalize carries the fields the first attempt could not. So the
 * fields may arrive AFTER the row does — but only under rules, because every
 * one of them is a way to change money after the fact.
 *
 * Extracted from the route so the races are testable: the whole point of this
 * module is what happens when a worker, a second caller, or a state transition
 * moves the row between the read and the write.
 */

export interface LateFields {
    costCodeId?: string;
    projectId?: string;
}

export interface LateFieldRow {
    costCodeId: string | null;
    projectId: string | null;
    state: string;
    claimToken?: string | null;
}

/** A refusal, shaped so the route can hand it straight to NextResponse.json. */
export interface Denial {
    status: number;
    body: Record<string, unknown>;
}

export interface LateFieldsDeps {
    read(id: string): Promise<LateFieldRow | null>;
    /** updateMany fenced on {id, state, claimToken: null, <field>: null}; returns the count. */
    applyIfNull(id: string, state: string, toApply: Record<string, string>): Promise<number>;
    /** Re-runs the caller's authorization against a given project. */
    authorize(projectId: string | null): Promise<Denial | null>;
}

/** Late fields may only land while a row is still un-routed. */
export const LATE_FIELD_STATES = ["STAGING", "RECEIVED"];

export async function reconcileLateFields(
    id: string,
    lateFields: LateFields,
    deps: LateFieldsDeps,
): Promise<Denial | null> {
    const entries = Object.entries(lateFields).filter(([, value]) => value !== undefined) as Array<
        ["costCodeId" | "projectId", string]
    >;
    if (entries.length === 0) return null;

    const current = await deps.read(id);
    if (!current) return null;

    // NULL-OR-EQUAL only, and only BEFORE the row is routed.
    //
    // Past RECEIVED the read has already happened: the dedup keys, the phase
    // suggestion and possibly a booking were all computed from the project this
    // row had at the time. Changing it afterwards does not re-derive any of
    // that — it just makes the row disagree with its own history, and after
    // BOOKED it disagrees with a Purchase in the real books.
    if (!LATE_FIELD_STATES.includes(current.state)) {
        const differs = entries.some(([key, value]) => current[key] !== value);
        if (!differs) return null; // already exactly what the caller is asking for
        return {
            status: 409,
            body: {
                ok: false,
                error: "late-fields-too-late",
                reason: `this row is ${current.state}; its job and phase were already used to route it`,
                state: current.state,
            },
        };
    }

    const conflicts = entries.filter(([key, value]) => current[key] !== null && current[key] !== value);
    if (conflicts.length > 0) {
        return {
            status: 409,
            body: {
                ok: false,
                error: "late-fields-conflict",
                reason: "this row already carries different values for these fields",
                fields: Object.fromEntries(
                    conflicts.map(([key]) => [key, { stored: current[key], supplied: lateFields[key] }]),
                ),
            },
        };
    }

    const toApply = Object.fromEntries(entries.filter(([key]) => current[key] === null));
    if (Object.keys(toApply).length === 0) return null;

    // THE ROW MUST BE UNCLAIMED.
    //
    // A worker that claimed this row read its projectId at claim time and is
    // routing on that value right now. Writing a project underneath it does not
    // change what it decided — it just makes the row disagree with the routing
    // it is about to publish (a receipt that now HAS a job, parked NEEDS_JOB).
    // The fence is applied by the caller's `applyIfNull`.
    const count = await deps.applyIfNull(id, current.state, toApply as Record<string, string>);
    if (count > 0) return null;

    // The CAS lost. That is NOT automatically "busy": the same zero comes back
    // when a concurrent caller already wrote exactly these values, when the
    // state moved, and when a DIFFERENT project was written underneath us.
    // Re-read and decide from what is persisted, not from the stale read.
    const after = await deps.read(id);
    const settled = after !== null && entries.every(([key, value]) => after[key] === value);
    if (!settled) {
        return {
            status: 409,
            body: {
                ok: false,
                error: "late-fields-busy",
                reason: "this row changed underneath the write; retry in a moment",
                retryable: after?.claimToken != null,
                state: after?.state ?? "gone",
            },
        };
    }

    // The values match — but a concurrent write may have moved the PROJECT, and
    // the phase we were asked to accept was authorized against the project this
    // row had BEFORE that. Re-authorize against the project the row carries
    // now; otherwise losing a race is a way to attach a cost code from another
    // job, which is exactly what the first authorization existed to prevent.
    return await deps.authorize(after.projectId);
}

/**
 * A phase is only valid against the job it belongs to.
 *
 * Shared by /start and /finalize deliberately. /start used to store a
 * caller-supplied `costCodeId` unchecked, and nothing downstream re-checked it:
 * /finalize only authorizes the fields the finalize CALL carries, so omitting
 * the field there let a cross-project phase survive all the way into the
 * Expense — where every variance report reads it as overspend on a line nobody
 * budgeted, on a job that never bought it.
 */
export async function authorizePhase(
    projectId: string | null,
    costCodeId: string | null,
    isCostCodeAllowed: (projectId: string, costCodeId: string) => Promise<boolean>,
): Promise<Denial | null> {
    if (!costCodeId) return null;
    if (!projectId) {
        return {
            status: 400,
            body: {
                ok: false,
                error: "cost-code-without-project",
                reason: "a phase is only meaningful against a job",
            },
        };
    }
    if (!(await isCostCodeAllowed(projectId, costCodeId))) {
        return {
            status: 400,
            body: {
                ok: false,
                error: "cost-code-not-a-phase",
                reason: "that cost code is not a phase of this job",
                projectId,
            },
        };
    }
    return null;
}
