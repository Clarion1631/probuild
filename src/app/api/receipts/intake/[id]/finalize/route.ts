import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateIntake, STAFF_READ_ROLES, type IntakeAuth } from "@/lib/receipt-intake/intake-auth";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { MAX_STORED_BYTES } from "@/lib/receipt-intake/intake-core";
import { inspectStoredObject, sealAndPublish } from "@/lib/receipt-intake/stored-object";
import {
    authorizePhase,
    reconcileLateFields,
    type Denial,
    type LateFields,
} from "@/lib/receipt-intake/late-fields";
import {
    deleteObjectOrRecord,
    rejectRowAndQueueCleanup,
    sealObject,
    settleQueuedCleanup,
} from "@/lib/receipt-intake/storage-cleanup";

export const dynamic = "force-dynamic";

/**
 * Route adapter over the late-field rules (src/lib/receipt-intake/late-fields.ts).
 *
 * The rules live in a lib because their interesting behaviour is entirely about
 * races — a worker claiming the row, a state transition, a second caller
 * writing a different project — and none of that is reachable from a test that
 * has to stand up a route handler.
 */
async function applyLateFields(
    id: string,
    lateFields: LateFields,
    auth: Extract<IntakeAuth, { ok: true }>,
): Promise<NextResponse | null> {
    const denial = await reconcileLateFields(id, lateFields, {
        read: rowId => prisma.receiptIntake.findUnique({
            where: { id: rowId },
            select: { costCodeId: true, projectId: true, state: true, claimToken: true },
        }),
        applyIfNull: async (rowId, state, toApply) => {
            const { count } = await prisma.receiptIntake.updateMany({
                where: {
                    id: rowId,
                    state,
                    claimToken: null,
                    ...Object.fromEntries(Object.keys(toApply).map(key => [key, null])),
                },
                data: toApply,
            });
            return count;
        },
        authorize: projectId => authorizeLateFields(auth, projectId, lateFields),
    });
    return denial ? NextResponse.json(denial.body, { status: denial.status }) : null;
}

/**
 * A caller may only attach a job it can actually reach, and only a phase that
 * belongs to that job.
 *
 * Without the first check any authenticated user could file a receipt against
 * any project by id. Without the second, a cost code from another job rides
 * into the Expense and every variance report reads it as overspend on a line
 * nobody budgeted.
 */
async function authorizeLateFields(
    auth: Extract<IntakeAuth, { ok: true }>,
    rowProjectId: string | null,
    lateFields: LateFields,
): Promise<Denial | null> {
    const projectId = lateFields.projectId ?? rowProjectId;

    if (lateFields.projectId && auth.via === "session") {
        if (!(await userCanAccessProject(auth.user, lateFields.projectId))) {
            return { status: 403, body: { ok: false, reason: "forbidden" } };
        }
    }

    // Same rule, same implementation, as /start applies to a phase supplied
    // there — the two must never be able to disagree.
    return await authorizePhase(projectId, lateFields.costCodeId ?? null, (project, code) =>
        isCostCodeAllowedForProject(prismaPhaseDataSource, project, code));
}
export const maxDuration = 30;

/**
 * Step 2 of the two-step upload: verify what actually landed, then publish.
 *
 * Everything here is checked against the STORED OBJECT, never against what the
 * client says about it. The client uploaded directly to Supabase, so this is the
 * only point at which the server sees the bytes at all — trusting a declared
 * hash, size or type would mean the row's `fileSha256` (which decides whether a
 * replay is a duplicate or a conflict) was attacker-supplied.
 *
 * STAGING -> RECEIVED is the publish, and it is the only thing that makes the
 * row visible to the worker.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
    const auth = await authenticateIntake(req, "ingest");
    if (!auth.ok) return auth.response;

    const { id } = await context.params;

    let body: { sha256?: unknown; costCodeId?: unknown; projectId?: unknown } = {};
    try {
        body = await req.json();
    } catch {
        // A finalize with no body is fine — the declared hash is optional.
    }
    const declaredSha = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : null;

    // LATE FIELDS. A client that learned the job only after starting the upload
    // sends them here. They are applied WHERE NULL and refused where they
    // disagree — silently overwriting a value a human already set is the one
    // outcome that loses information nobody can recover.
    //
    // NOTE: Phase 3's `installedAtCustomer` does not exist on this model; the
    // same rule will apply to it when it lands.
    const lateInput = {
        costCodeId: typeof body.costCodeId === "string" && body.costCodeId.trim() ? body.costCodeId.trim() : null,
        projectId: typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null,
    };
    const lateFields = Object.fromEntries(
        Object.entries(lateInput).filter(([, v]) => v !== null),
    ) as Partial<{ costCodeId: string; projectId: string }>;

    const row = await prisma.receiptIntake.findUnique({
        where: { id },
        select: {
            id: true, state: true, stateReason: true, sourceRef: true, storagePath: true,
            mimeType: true, projectId: true, dryRun: true, createdById: true,
            fileSha256: true, expectedSha256: true,
        },
    });
    if (!row) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

    // Same rule as the conflict path: a session caller may only finalize its
    // OWN row (or hold a bookkeeping role). Otherwise a guessed id would let one
    // user publish another's upload.
    const maySee =
        auth.via === "secret" ||
        row.createdById === auth.user.id ||
        STAFF_READ_ROLES.includes(auth.user.role);
    if (!maySee) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

    // Authorize the late fields BEFORE anything is written or published.
    const denied = await authorizeLateFields(auth, row.projectId, lateFields);
    if (denied) return NextResponse.json(denied.body, { status: denied.status });

    // A LATE finalize on a row the sweeper already parked file-missing is a
    // RECOVERY, not a duplicate: the upload landed after the sweep looked. It
    // must re-validate and republish rather than report alreadyFinalized, which
    // would leave a real receipt parked forever while telling the caller it was
    // fine.
    // Both sweeper parks are recoverable by a later, correct upload: the bytes
    // arriving after the sweep looked is the normal shape of a slow client, not
    // an error state a human should have to clear.
    const recoverable = row.state === "STAGING"
        || (row.state === "NEEDS_REVIEW"
            && (row.stateReason === "file-missing" || row.stateReason === "sha-mismatch"));

    // Idempotent: finalizing an already-published row is a success, not an error
    // — the client's retry after a lost response must not look like a failure.
    //
    // But the late fields are reconciled FIRST. A sequential retry arriving
    // after the row already reached RECEIVED still carries them, and answering
    // alreadyFinalized without applying them drops the job assignment on the
    // floor while telling the caller it worked. Same behaviour as the
    // two-publisher path below, because a caller cannot tell which one it hit.
    if (!recoverable) {
        const conflict = await applyLateFields(id, lateFields, auth);
        if (conflict) return conflict;
        // PERSISTED values, re-read after the reconcile — the caller must be
        // told what the row actually holds, not what it asked for.
        const persisted = await prisma.receiptIntake.findUnique({
            where: { id },
            select: {
                state: true, sourceRef: true, projectId: true, costCodeId: true,
                dryRun: true, fileSize: true, fileSha256: true,
            },
        });
        return NextResponse.json({ ok: true, alreadyFinalized: true, id, ...(persisted ?? {}) });
    }

    // ONE validator, shared with the worker's stale-STAGING sweep — see
    // stored-object.ts. If the two disagreed, whichever ran first would decide
    // whether a 40 MB video became a receipt.
    const check = await inspectStoredObject(row.storagePath, row.mimeType);
    if (!check.ok) {
        if (check.kind === "missing") {
            // The upload never landed. Retryable, and NEVER a 2xx: the
            // forwarders treat 2xx as "we have it" and would drop their copy.
            return NextResponse.json(
                { ok: false, error: "object-missing", reason: "upload the bytes to the signed URL first" },
                { status: 409 },
            );
        }
        if (check.kind === "transient") {
            return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
        }
        // REJECTED. The row goes, and so must the object — but the two writes
        // are ONE transaction. A best-effort delete followed by a best-effort
        // cleanup could drop the row and lose the object with nothing left
        // referencing or remembering it.
        const rejected = await rejectRowAndQueueCleanup(id, row.storagePath, check.reason);
        if (!rejected.ok) {
            // The row's deletion is not confirmed, so it may still point at
            // these bytes. Keep the object and answer retryably; an identical
            // retry re-validates and rejects again.
            return NextResponse.json({ ok: false, reason: "reject-failed", retryable: true }, { status: 503 });
        }
        await settleQueuedCleanup(rejected.eventId, row.storagePath);
        const status = check.reason.startsWith("file-too-large") ? 413 : 400;
        return NextResponse.json(
            { ok: false, reason: check.reason, maxBytes: MAX_STORED_BYTES },
            { status },
        );
    }

    const { mimeType, fileSize, fileSha256 } = check;

    // THE HASH IS CHECKED AGAINST BOTH RECORDED EXPECTATIONS.
    //
    // `expectedSha256` was written by /start from what the client said it was
    // about to upload; `declaredSha` is what it says now. Either disagreeing
    // with the stored bytes means the object is not the document this row was
    // created for — which is exactly the case a reused sourceRef produces, and
    // the case that would otherwise attach one receipt's bytes to another
    // receipt's identity.
    for (const [label, expected] of [["declared", declaredSha], ["expected", row.expectedSha256]] as const) {
        if (expected && expected.toLowerCase() !== fileSha256) {
            return NextResponse.json(
                {
                    ok: false,
                    error: "sha-mismatch",
                    reason: `stored bytes do not match the ${label} sha256`,
                    storedSha256: fileSha256,
                },
                { status: 409 },
            );
        }
    }

    // ONE shared seal-and-publish, also used by the worker's stale-STAGING
    // sweep, so the two publishers cannot diverge on ordering or fencing.
    const outcome = await sealAndPublish(row.storagePath, id, check, {
        seal: sealObject,
        commit: async (canonicalPath, values) => {
            const { count } = await prisma.receiptIntake.updateMany({
                // Fenced: only a row still in a publishable state moves, so a
                // loser of the race writes nothing.
                where: { id, state: { in: ["STAGING", "NEEDS_REVIEW"] } },
                data: {
                    state: "RECEIVED",
                    stateReason: null,
                    storagePath: canonicalPath,
                    mimeType: values.mimeType,
                    fileSize: values.fileSize,
                    fileSha256: values.fileSha256,
                    nextRetryAt: null,
                    ...lateFields,
                },
            });
            return count;
        },
        dropUpload: uploadPath => deleteObjectOrRecord(uploadPath, "sealed").then(() => undefined),
    });

    if (!outcome) {
        return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
    }
    if (!outcome.published) {
        // Another publisher won. Same outcome for the caller — but the late
        // fields still have to be reconciled against what that publisher wrote.
        const reconciled = await applyLateFields(id, lateFields, auth);
        if (reconciled) return reconciled;
        const current = await prisma.receiptIntake.findUnique({
            where: { id },
            select: { state: true, sourceRef: true, projectId: true, dryRun: true },
        });
        return NextResponse.json({ ok: true, alreadyFinalized: true, id, state: current?.state ?? "RECEIVED" });
    }

    const persisted = await prisma.receiptIntake.findUnique({
        where: { id },
        select: {
            state: true, sourceRef: true, projectId: true, costCodeId: true,
            dryRun: true, fileSize: true, fileSha256: true,
        },
    });
    return NextResponse.json({ ok: true, id, ...(persisted ?? { state: "RECEIVED", fileSize }) });
}
