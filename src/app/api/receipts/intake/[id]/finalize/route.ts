import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateIntake, STAFF_READ_ROLES, type IntakeAuth } from "@/lib/receipt-intake/intake-auth";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { assertPhaseOfProjectTx } from "@/lib/phase-invariant";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import { captureActorSource, optionalBool } from "@/lib/receipt-capture-validation";
import { MAX_STORED_BYTES } from "@/lib/receipt-intake/intake-core";
import { receiptObjectSize } from "@/lib/receipt-intake/bucket";
import {
    finalizeDisposition,
    inspectStoredObject,
    publishFence,
    sealAndPublish,
} from "@/lib/receipt-intake/stored-object";
import {
    authorizeEffectiveProject,
    authorizePhase,
    mergeCapturedFields,
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
 * A "we already have it" answer has to be TRUE.
 *
 * Both replay paths used to return success from the row alone. The forwarders
 * treat that as permission to delete their only copy — so a row whose object had
 * gone missing (a bad publish, a cleanup that ran on the wrong path, a bucket
 * incident) got a cheerful 200 and the receipt ceased to exist anywhere.
 *
 * Metadata only, and bounded: one small `list` regardless of the object's size.
 * The three answers are deliberately different — an absence is a 409 the sender
 * can act on by re-uploading, a storage fault is a 503 it should simply retry,
 * and only a confirmed presence is success.
 */
async function confirmStoredCopy(storagePath: string): Promise<NextResponse | null> {
    const present = await receiptObjectSize(storagePath);
    if (present.ok) return null;
    if (present.kind === "transient") {
        return NextResponse.json({ ok: false, reason: "storage-unavailable", retryable: true }, { status: 503 });
    }
    return NextResponse.json(
        {
            ok: false,
            error: "file-missing",
            reason: "this row exists but its stored document is gone; send the bytes again",
            retryable: true,
        },
        { status: 409 },
    );
}

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
            // `installedAtCustomer` rides the same null-or-equal,
            // only-before-routed, unclaimed rule as the two ids.
            //
            // `costCodeSource` MUST be here. This route adds it to `lateFields`
            // whenever a phase is supplied (it is derived from the caller, not
            // read off the body), so it is a key the rules reconcile — and a
            // reconciled key that is not SELECTed comes back `undefined`, which
            // the null-or-equal test scores as "already carries a different
            // value". Every finalize carrying a costCodeId 409'd with
            // `late-fields-conflict` on a field the caller never sent, and the
            // phase was never applied (e2e/receipt-intake.spec.ts rounds 9+10).
            // `reconcileLateFields` now throws rather than silently refusing if
            // this drifts again.
            select: {
                costCodeId: true, costCodeSource: true, projectId: true,
                installedAtCustomer: true, state: true, claimToken: true,
            },
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
        authorize: projectId => authorizeFinalization(auth, projectId, lateFields),
    });
    return denial ? NextResponse.json(denial.body, { status: denial.status }) : null;
}

/**
 * A caller may only finalize against a job it can actually reach, and may only
 * attach a phase that belongs to that job.
 *
 * Without the first check any authenticated user could file a receipt against
 * any project by id — and, before this authorized the EFFECTIVE project rather
 * than only a supplied one, a user whose access had been revoked could still
 * publish and phase their existing row on that job simply by not mentioning it.
 * Without the second, a cost code from another job rides into the Expense and
 * every variance report reads it as overspend on a line nobody budgeted.
 */
/** Exported for tests/finalize-late-field-authz.test.ts — the project-access
 *  half of this is the only thing standing between a late `projectId` and a
 *  job the caller cannot see. */
export async function authorizeFinalization(
    auth: Extract<IntakeAuth, { ok: true }>,
    rowProjectId: string | null,
    lateFields: LateFields,
): Promise<Denial | null> {
    const projectId = lateFields.projectId ?? rowProjectId;

    // EVERY session call, not just the ones carrying a project. The shared
    // secret is a trusted forwarder with no user to scope by.
    if (auth.via === "session") {
        const forbidden = await authorizeEffectiveProject(
            rowProjectId,
            lateFields.projectId ?? null,
            candidate => userCanAccessProject(auth.user, candidate),
        );
        if (forbidden) return forbidden;
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

    // A GENUINELY empty body means "no fields" — the declared hash and the
    // late fields are all optional. But `req.json()` throws on malformed JSON
    // too, and a bare try/catch could not tell the two apart: a truncated or
    // corrupted body was silently treated as an empty one, so a request-level
    // bug never surfaced as an error the caller could see or retry against.
    // Reading the raw text first is what makes the difference legible: only a
    // body that is empty (or whitespace) after trimming may mean "no fields".
    let body: { sha256?: unknown; costCodeId?: unknown; projectId?: unknown; installedAtCustomer?: unknown } = {};
    const rawBody = await req.text();
    if (rawBody.trim()) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawBody);
        } catch {
            return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
        }
        // Parsing can SUCCEED on a value that is not "no fields" either: a bare
        // string, number, boolean, or array is valid JSON, but every field read
        // off it (body.sha256, body.costCodeId, ...) comes back undefined —
        // indistinguishable from a genuinely empty body, so it fell through to
        // the same 200 with nothing applied. Only a plain object can carry late
        // fields; anything else is refused the same as malformed JSON.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
        }
        body = parsed as typeof body;
    }
    const declaredSha = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : null;

    // LATE FIELDS. A client that learned the job only after starting the upload
    // sends them here. They are applied WHERE NULL and refused where they
    // disagree — silently overwriting a value a human already set is the one
    // outcome that loses information nobody can recover.
    //
    // Phase 3's `installedAtCustomer` rides the same rule. It is a TRI-STATE,
    // so "the caller did not say" (null) is excluded from the set below exactly
    // like an absent id — silence is never an answer, and never overwrites one.
    const lateInput = {
        costCodeId: typeof body.costCodeId === "string" && body.costCodeId.trim() ? body.costCodeId.trim() : null,
        projectId: typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null,
        installedAtCustomer: optionalBool(body.installedAtCustomer),
    };
    const lateFields = Object.fromEntries(
        Object.entries(lateInput).filter(([, v]) => v !== null),
    ) as LateFields;
    // A LATE PHASE CARRIES THE SAME PROVENANCE A CAPTURED ONE DOES.
    //
    // Derived from the CALLER, never read off the body: a signed-in person
    // answering is "user", a shared-secret forwarder resolving the job from a
    // Drive folder is "machine". Booking makes the first untouchable and leaves
    // the second correctable, which is the whole point of recording it.
    if (lateFields.costCodeId) {
        lateFields.costCodeSource = captureActorSource(auth.via);
    }

    const row = await prisma.receiptIntake.findUnique({
        where: { id },
        select: {
            id: true, source: true, state: true, stateReason: true, sourceRef: true, storagePath: true,
            mimeType: true, projectId: true, costCodeId: true, dryRun: true, createdById: true,
            fileSha256: true, expectedSha256: true, uploadLeaseVersion: true,
            // Part of the merge and the publish CAS for the same reason
            // `installedAtCustomer` is: a captured field this read omits is a
            // field `mergeCapturedFields` sees as null and overwrites. /start
            // stamps this from ITS caller, so leaving it out let a machine
            // finalize relabel a person's phase as machine-set — and booking
            // treats a user-set phase as untouchable and a machine-set one as
            // correctable.
            costCodeSource: true,
            // A CAPTURED TAX ANSWER, and therefore part of the merge and the
            // publish CAS. Leaving it out of this read made the publish the one
            // path that could overwrite it: `mergeCapturedFields` saw no stored
            // value, so a late `false` landed on a row that already said `true`
            // and the excise report changed answer with nothing recording that
            // the first one existed.
            installedAtCustomer: true,
        },
    });
    if (!row) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

    // A SECRET OWNS SOURCES, NOT ROWS.
    //
    // decideSource already refuses to let a forwarder CREATE a row outside its
    // own namespace, but finalize took `via === "secret"` as blanket authority
    // over any id — so the Apps Script key could publish, re-point and attach a
    // job to a mobile capture or a web upload that belongs to a person. The
    // same list that scopes creation scopes this: an ingest key owns
    // drive/email/chat, and nothing else.
    //
    // 403, not 404: the caller is authenticated and the row is real; what it
    // lacks is authority. Checked BEFORE any detail is returned or written.
    if (auth.via === "secret" && !auth.allowedSources.has(row.source)) {
        return NextResponse.json(
            {
                ok: false,
                error: "source-not-owned",
                reason: `this key does not own ${row.source} rows`,
            },
            { status: 403 },
        );
    }

    // Same rule as the conflict path: a session caller may only finalize its
    // OWN row (or hold a bookkeeping role). Otherwise a guessed id would let one
    // user publish another's upload.
    const maySee =
        auth.via === "secret" ||
        row.createdById === auth.user.id ||
        STAFF_READ_ROLES.includes(auth.user.role);
    if (!maySee) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

    // Authorize the late fields BEFORE anything is written or published.
    const denied = await authorizeFinalization(auth, row.projectId, lateFields);
    if (denied) return NextResponse.json(denied.body, { status: denied.status });

    // A LATE finalize on a row the sweeper already parked file-missing is a
    // RECOVERY, not a duplicate: the upload landed after the sweep looked. It
    // must re-validate and republish rather than report alreadyFinalized, which
    // would leave a real receipt parked forever while telling the caller it was
    // fine. Both sweeper parks are recoverable that way — bytes arriving after
    // the sweep looked is the normal shape of a slow client, not an error state
    // a human has to clear. Every OTHER park is a human's decision, and this
    // path must not launder it into RECEIVED.
    const disposition = finalizeDisposition(row);
    if (disposition === "not-recoverable") {
        return NextResponse.json(
            {
                ok: false,
                error: "not-recoverable",
                reason: "this row is parked for review; a re-upload does not clear it",
                state: row.state,
                stateReason: row.stateReason,
            },
            { status: 409 },
        );
    }
    const recoverable = disposition === "publish";

    // Idempotent: finalizing an already-published row is a success, not an error
    // — the client's retry after a lost response must not look like a failure.
    //
    // But the late fields are reconciled FIRST. A sequential retry arriving
    // after the row already reached RECEIVED still carries them, and answering
    // alreadyFinalized without applying them drops the job assignment on the
    // floor while telling the caller it worked. Same behaviour as the
    // two-publisher path below, because a caller cannot tell which one it hit.
    if (!recoverable) {
        // The object first: `alreadyFinalized` is what makes a forwarder drop
        // its copy, so it must not be said about a row whose bytes are gone.
        const missing = await confirmStoredCopy(row.storagePath);
        if (missing) return missing;
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
        const rejected = await rejectRowAndQueueCleanup(
            {
                id,
                state: row.state,
                stateReason: row.stateReason,
                storagePath: row.storagePath,
                uploadLeaseVersion: row.uploadLeaseVersion,
            },
            check.reason,
        );
        if (!rejected.ok) {
            // The fence lost, so this row is not ours to reject: a publisher
            // moved it (or claimed it) while we were inspecting the object.
            // NOTHING is deleted — not the row, not the object, not even a
            // cleanup record — because those bytes may now belong to a
            // published receipt.
            return NextResponse.json(
                {
                    ok: false,
                    error: "publish-conflict",
                    reason: "this row changed while it was being rejected; retry",
                    retryable: true,
                },
                { status: 409 },
            );
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

    // THE PUBLISH IS SUBJECT TO THE SAME NULL-OR-EQUAL RULE as every other
    // late-field write.
    //
    // This used to spread `lateFields` straight into the publishing update,
    // which made initial publication the one path that could silently REPLACE a
    // job, a phase or a tax answer captured at /start. A client that captured
    // the job at /start and sent a different one at finalize simply won, and
    // nothing recorded that the first answer had ever existed.
    const merged = mergeCapturedFields(
        {
            projectId: row.projectId,
            costCodeId: row.costCodeId,
            costCodeSource: row.costCodeSource,
            installedAtCustomer: row.installedAtCustomer,
        },
        lateFields,
    );
    if ("status" in merged) return NextResponse.json(merged.body, { status: merged.status });

    // AND THE RESULTING TUPLE IS VALIDATED, not the supplied half of it.
    //
    // authorizeFinalization above only saw what this REQUEST carried. A finalize
    // that sends projectId=B against a phase captured for job A supplies a
    // project that is fine on its own and a phase it never mentions — and the
    // row ends up filed under B's job with A's phase. The check has to be on
    // the pair the row will actually hold.
    const mixed = merged.from.projectId !== merged.from.costCodeId;
    const badTuple = await authorizePhase(
        merged.resulting.projectId,
        merged.resulting.costCodeId,
        (project, code) => isCostCodeAllowedForProject(prismaPhaseDataSource, project, code),
    );
    if (badTuple) {
        // A caller's OWN bad pair is a 400 (fix the request). A pair only this
        // MERGE created — half captured, half late — is a 409: the request is
        // well-formed, it just disagrees with what the row already holds.
        return mixed
            ? NextResponse.json(
                {
                    ...badTuple.body,
                    error: "captured-phase-conflict",
                    reason: "the phase already on this row is not a phase of the job you sent",
                    captured: { projectId: row.projectId, costCodeId: row.costCodeId },
                    resulting: merged.resulting,
                },
                { status: 409 },
            )
            : NextResponse.json(badTuple.body, { status: badTuple.status });
    }

    // ONE shared seal-and-publish, also used by the worker's stale-STAGING
    // sweep, so the two publishers cannot diverge on ordering or fencing.
    // Set by the commit below when the phase stopped being one while we were
    // publishing. Distinct from a lost CAS, which means somebody else moved the
    // row — this means the row is fine and the world changed around it.
    let phaseRejectedAtPublish: string | null = null;
    const outcome = await sealAndPublish(row.storagePath, id, check, {
        seal: sealObject,
        commit: async (canonicalPath, values) => prisma.$transaction(async tx => {
            // THE PHASE ANSWER THAT COUNTS (round 17, item 5).
            //
            // `authorizePhase` above ran on the global client and held nothing.
            // This one locks the four tables the answer rests on and reads them
            // on the transaction that is about to publish, so an estimate
            // archived or reassigned, or a code deactivated, in that window
            // cannot be published onto the row.
            if (merged.resulting.costCodeId) {
                const verdict = await assertPhaseOfProjectTx(
                    tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                    merged.resulting.projectId,
                    merged.resulting.costCodeId,
                );
                if (!verdict.ok) {
                    phaseRejectedAtPublish = verdict.reason;
                    return 0;
                }
            }
            const { count } = await tx.receiptIntake.updateMany({
                // Fenced on the EXACT state and reason observed, on the row
                // being unclaimed, and on every captured value this publish was
                // validated against. Anything that moved between the read and
                // this write — a re-park under a different reason, a worker
                // claim, a job filled in — invalidates what was checked above,
                // so the publish must lose rather than overwrite it.
                where: { id, ...publishFence(row), ...merged.guard },
                data: {
                    state: "RECEIVED",
                    stateReason: null,
                    storagePath: canonicalPath,
                    mimeType: values.mimeType,
                    fileSize: values.fileSize,
                    fileSha256: values.fileSha256,
                    nextRetryAt: null,
                    // NULL-OR-EQUAL: only the fields the row does not already
                    // answer. Never a blind spread of what the caller sent.
                    ...merged.apply,
                },
            });
            return count;
        }),
        dropUpload: uploadPath => deleteObjectOrRecord(uploadPath, "sealed").then(() => undefined),
        currentStoragePath: async rowId => {
            const r = await prisma.receiptIntake.findUnique({ where: { id: rowId }, select: { storagePath: true } });
            return r?.storagePath ?? null;
        },
        // A lost CAS here means another /finalize (or the worker's
        // stale-STAGING sweep) already published this row while we were
        // mid-request — best-effort so a slow deleteObjectOrRecord failure
        // still lands on the same retry queue as every other orphan.
        dropOrphanedCanonical: canonicalPath =>
            deleteObjectOrRecord(canonicalPath, "orphaned-lost-publish-cas").then(() => undefined),
    });

    if (!outcome) {
        return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
    }
    // Checked BEFORE the lost-CAS branch: nothing was published, and answering
    // "already finalized" would be a lie the client acts on.
    if (phaseRejectedAtPublish) {
        return NextResponse.json(
            {
                ok: false,
                error: "phase-not-on-project",
                reason: `the phase stopped being one of this job's phases while publishing (${phaseRejectedAtPublish})`,
            },
            { status: 409 },
        );
    }
    if (!outcome.published) {
        // The CAS lost — which is now TWO different things. Either another
        // publisher moved the row (the caller's answer is "already finalized"),
        // or a captured value changed underneath a row that is still waiting to
        // publish, in which case nothing was published and saying otherwise
        // would be a lie the client acts on.
        //
        // "Not STAGING" is NOT enough evidence of the first case. A concurrent
        // /start rearm can move a recoverable NEEDS_REVIEW row onto a fresh
        // upload lease without ever publishing it — the row is still
        // NEEDS_REVIEW, but a re-armed upload can genuinely be present at the
        // (new) storagePath, so `confirmStoredCopy` alone cannot tell "someone
        // published" from "someone is mid re-upload of something else". The
        // only positive proof that ANOTHER publisher published THIS content is
        // that the row's canonical path now equals the one this call itself
        // just verified (sealAndPublish names it after id+sha+mime) — that
        // string can only be written by a successful sealAndPublish commit, and
        // only with these exact bytes.
        const current = await prisma.receiptIntake.findUnique({
            where: { id },
            select: {
                state: true, sourceRef: true, projectId: true, dryRun: true,
                storagePath: true, fileSha256: true,
                costCodeId: true, installedAtCustomer: true,
            },
        });
        const positivelyPublished = !!current
            && current.state !== "STAGING"
            && current.storagePath === outcome.canonicalPath
            && current.fileSha256 === fileSha256;
        if (!positivelyPublished) {
            return NextResponse.json(
                {
                    ok: false,
                    error: "publish-conflict",
                    reason: "this row changed while it was being published; retry",
                    retryable: true,
                },
                { status: 409 },
            );
        }
        // Another publisher won, with the SAME content this call verified.
        // Same outcome for the caller — but the late fields still have to be
        // reconciled against what that publisher wrote, and the same "do we
        // actually hold it" rule applies.
        const missing = await confirmStoredCopy(current.storagePath);
        if (missing) return missing;
        const reconciled = await applyLateFields(id, lateFields, auth);
        if (reconciled) return reconciled;
        return NextResponse.json({ ok: true, alreadyFinalized: true, id, state: current.state });
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
