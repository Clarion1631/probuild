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

/**
 * Fields CAPTURED when the row was created, which a later finalize may fill in
 * but never overwrite.
 *
 * `installedAtCustomer` is listed deliberately even though the column does not
 * exist yet (it lands in Phase 3): the rule is written over whatever keys the
 * caller hands in, so the field is covered the day it is added rather than
 * needing somebody to remember this file. It is a TAX answer — whether the
 * material was installed at the customer's site decides how the purchase is
 * taxed — so an overwrite there is a wrong number in the books, not a mislabel.
 */
export const CAPTURED_FIELDS = ["projectId", "costCodeId", "installedAtCustomer"] as const;

export type CapturedValues = Record<string, string | boolean | null | undefined>;

export interface CapturedMerge {
    /** Only the fields that are actually changing. */
    apply: Record<string, string>;
    /**
     * The ORIGINAL captured values, for a CAS on the publishing update: if any
     * of them moved between the read and the write, the publish must lose.
     */
    guard: Record<string, string | boolean | null>;
    /** What the row will hold once `apply` lands. */
    resulting: { projectId: string | null; costCodeId: string | null };
    /** Where each half of the resulting phase tuple came from. */
    from: { projectId: "captured" | "late" | "none"; costCodeId: "captured" | "late" | "none" };
}

/**
 * NULL-OR-EQUAL at publish time too.
 *
 * Initial publication used to spread the finalize's late fields straight over
 * the row, which made /finalize the one path that could silently REPLACE a job,
 * phase or tax answer captured at /start — the exact overwrite every other path
 * refuses. A client that captured the job at /start and sent a different one at
 * finalize simply won, and nothing recorded that the first answer ever existed.
 */
export function mergeCapturedFields(
    captured: CapturedValues,
    lateFields: LateFields,
): Denial | CapturedMerge {
    const apply: Record<string, string> = {};
    const guard: Record<string, string | boolean | null> = {};
    const conflicts: Record<string, { stored: unknown; supplied: unknown }> = {};

    for (const [key, value] of Object.entries(captured)) {
        // The CAS covers EVERY captured field, not just the ones being written:
        // a concurrent writer that filled in the phase we are about to leave
        // alone still invalidates the tuple this publish validated.
        guard[key] = value ?? null;
    }

    for (const [key, supplied] of Object.entries(lateFields)) {
        if (supplied === undefined) continue;
        const stored = captured[key] ?? null;
        if (stored === null) {
            apply[key] = supplied;
            continue;
        }
        if (stored !== supplied) conflicts[key] = { stored, supplied };
    }

    if (Object.keys(conflicts).length > 0) {
        return {
            status: 409,
            body: {
                ok: false,
                error: "late-fields-conflict",
                reason: "this row already carries different values for these fields",
                fields: conflicts,
            },
        };
    }

    const pick = (key: "projectId" | "costCodeId") => {
        const stored = (captured[key] ?? null) as string | null;
        if (stored !== null) return { value: stored, from: "captured" as const };
        const late = lateFields[key] ?? null;
        return late !== null
            ? { value: late, from: "late" as const }
            : { value: null, from: "none" as const };
    };
    const project = pick("projectId");
    const phase = pick("costCodeId");

    return {
        apply,
        guard,
        resulting: { projectId: project.value, costCodeId: phase.value },
        from: { projectId: project.from, costCodeId: phase.from },
    };
}

/**
 * The project this finalization actually touches — checked on EVERY session
 * call, not only when the request supplies a new one.
 *
 * The old rule authorized `lateFields.projectId` and nothing else, so access was
 * only ever re-checked when the caller happened to send a project. A user whose
 * access to a job had been revoked could still finalize (publish) their existing
 * row on that job, and still attach a phase to it, because the request named no
 * project at all — the row already had one. Revocation has to bite on the
 * EFFECTIVE project: what the row will hold when this call is done.
 *
 * A row with no project either way is nothing to authorize: there is no job to
 * be revoked from. Ownership of the row itself is a separate check.
 */
export async function authorizeEffectiveProject(
    storedProjectId: string | null,
    lateProjectId: string | null,
    canAccessProject: (projectId: string) => Promise<boolean>,
): Promise<Denial | null> {
    const effective = lateProjectId ?? storedProjectId;
    if (!effective) return null;
    if (await canAccessProject(effective)) return null;
    return {
        status: 403,
        body: {
            ok: false,
            reason: "forbidden",
            error: "project-forbidden",
            projectId: effective,
        },
    };
}
