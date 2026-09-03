import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { authenticateIntake } from "@/lib/receipt-intake/intake-auth";
import { ACCEPTED_MIME_TYPES, EXT_BY_MIME } from "@/lib/receipt-intake/file-type";
import { decideSource, MAX_STORED_BYTES } from "@/lib/receipt-intake/intake-core";
import { uploadLeaseExpiry } from "@/lib/receipt-intake/worker";
import { authorizePhase } from "@/lib/receipt-intake/late-fields";
import {
    finalizeDisposition,
    publishFence,
    uploadPathFor,
    verifyStoredCopy,
} from "@/lib/receipt-intake/stored-object";
import { discardUnresumedLease, newLeaseNonce, reuseLiveLease } from "@/lib/receipt-intake/upload-lease";
import { createReceiptUploadUrl } from "@/lib/receipt-intake/bucket";
import { deleteObjectOrRecord } from "@/lib/receipt-intake/storage-cleanup";
import { isCostCodeAllowedForProject } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Step 1 of the two-step upload: reserve the row, hand back a signed URL.
 *
 * The single-shot POST /api/receipts/intake puts the file in the REQUEST BODY,
 * and a serverless body is not a 15 MB pipe — the platform caps it around
 * 4.5 MB and base64 inflates the payload by a third on top. Phone photos
 * routinely exceed that, and they were failing at the edge with an opaque 413
 * that never reached our code. This path never carries the bytes at all: the
 * client PUTs them straight to Supabase, which has no such limit.
 *
 * The signed URL is scoped to ONE path, which is derived here and bound to the
 * row — the client cannot choose where its bytes land, so it cannot overwrite
 * another receipt's object or write outside the intake prefix.
 *
 * No object exists yet, so the row is STAGING and the worker cannot see it.
 * /finalize is what publishes it.
 */
export async function POST(req: Request) {
    const auth = await authenticateIntake(req, "ingest");
    if (!auth.ok) return auth.response;

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

    // REFUSED BEFORE A ROW EXISTS. A 400 after creating the row left a STAGING
    // row for a document we will never accept, which the sweeper then has to
    // reason about. 415, not 400: the request is well-formed, the format is
    // simply one QuickBooks cannot attach.
    //
    // The declared mime only picks the extension; /finalize re-derives the real
    // type from the STORED BYTES, so a lie costs the caller its upload.
    const mimeType = String(body.mimeType ?? "").split(";")[0].trim().toLowerCase();
    const ext = EXT_BY_MIME[mimeType];
    if (!ext) {
        return NextResponse.json(
            {
                ok: false,
                error: "unsupported-file-type",
                reason: mimeType === "text/plain"
                    ? "text receipts are not accepted: QuickBooks cannot attach a .txt. Print or export it to PDF first."
                    : "that format is not one QuickBooks can attach",
                accepted: ACCEPTED_MIME_TYPES,
            },
            { status: 415 },
        );
    }

    // The client's own hash of what it is ABOUT to upload. Persisted, because
    // the two-step flow hands the bytes straight to storage: without it a
    // reused sourceRef carrying a DIFFERENT document is indistinguishable from
    // an honest retry, and /finalize would attach one receipt's bytes to
    // another receipt's identity.
    // REQUIRED, not optional.
    //
    // It is the only thing that gives this row an identity before any bytes
    // exist. Without it a reused sourceRef is indistinguishable from an honest
    // retry, so /start would happily hand out an upsert URL pointed at another
    // document's object — and the swap would only surface at /finalize, by
    // which point the original bytes are gone.
    const expectedSha256 = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
        return NextResponse.json(
            {
                ok: false,
                reason: "missing-sha256",
                detail: "sha256 of the bytes you are about to upload is required (64 lowercase hex chars)",
            },
            { status: 400 },
        );
    }

    const declaredSize = Number(body.fileSize);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_STORED_BYTES) {
        return NextResponse.json({ ok: false, reason: "file-too-large", maxBytes: MAX_STORED_BYTES }, { status: 413 });
    }

    const decided = decideSource(auth, {
        source: str(body.source),
        sourceRef: str(body.sourceRef),
        uploadId: str(body.uploadId),
        // Already validated above (64 lowercase hex): the client's own hash of
        // what it is about to upload is exactly the checksum a no-uploadId
        // session caller needs a STABLE key derived from.
        checksum: expectedSha256,
    });
    if (!decided.ok) return NextResponse.json({ ok: false, reason: decided.reason }, { status: 400 });

    const projectId = str(body.projectId);
    if (auth.via === "session" && projectId) {
        if (!(await userCanAccessProject(auth.user, projectId))) {
            return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
        }
    }

    // THE PHASE IS CHECKED HERE OR NOWHERE.
    //
    // A costCodeId supplied at /start used to be stored unchecked, and nothing
    // downstream re-checks it: /finalize only authorizes the fields the
    // FINALIZE call carries, so a client could smuggle a phase from another job
    // past every gate simply by omitting it at finalize. The FK gives a 400 for
    // a cost code that does not exist at all, which is a different question
    // from whether it belongs to this job.
    //
    // AFTER the project authorization above, never before: validating against a
    // project the caller cannot reach would answer questions about somebody
    // else's job.
    const costCodeId = str(body.costCodeId);
    const badPhase = await authorizePhase(projectId, costCodeId, (project, code) =>
        isCostCodeAllowedForProject(prismaPhaseDataSource, project, code));
    if (badPhase) return NextResponse.json(badPhase.body, { status: badPhase.status });

    const id = randomUUID();
    // Lease 1 from the outset: the version is part of the path, so there is no
    // "version 0" object to confuse with a resumed upload later.
    const storagePath = uploadPathFor(id, 1, ext);
    // Held in a const, not re-derived: it is the value written to the row AND
    // the value the discard below CASes on. Calling uploadLeaseExpiry() twice
    // would compare a fresh instant against the stored one and never match.
    const leaseExpiresAt = uploadLeaseExpiry();
    // The generation THIS request stamps on the lease. The expiry alone could
    // not identify it — a concurrent retry's reuse writes "now + 2h" too, and
    // the two can be the same millisecond — so the discard CAS pins this
    // instead. See discardUnresumedLease.
    const leaseNonce = newLeaseNonce();

    let created: { id: string; sourceRef: string; state: string };
    try {
        created = await prisma.receiptIntake.create({
            data: {
                id,
                source: decided.source,
                sourceRef: decided.sourceRef,
                state: "STAGING",
                dryRun: process.env.RECEIPT_INTAKE_DRYRUN !== "false",
                projectId,
                costCodeId,
                createdById: auth.via === "session" ? auth.user.id : null,
                // Forwarder-only, same as the single-shot path: this is the
                // claim that v1 already booked the document.
                archivedByV1: auth.via === "secret" && body.archivedByV1 === true,
                storagePath,
                fileName: str(body.fileName),
                mimeType,
                fileSize: 0,
                // Unknown until the bytes land. /finalize recomputes it FROM
                // STORAGE and writes the real value; a client-declared hash is
                // never trusted as the stored one — only checked against it.
                fileSha256: "",
                expectedSha256,
                // The promise this response makes: until then the client's URL
                // works, so nothing may declare the object missing or reject
                // the row for what is at that path.
                uploadUrlExpiresAt: leaseExpiresAt,
                uploadLeaseVersion: 1,
                uploadLeaseNonce: leaseNonce,
            },
            select: { id: true, sourceRef: true, state: true },
        });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            // Same sourceRef: hand back the row already in flight so a retrying
            // client resumes rather than orphaning a second object.
            const existing = await prisma.receiptIntake.findUnique({
                where: { sourceRef: decided.sourceRef },
                select: {
                    id: true, sourceRef: true, state: true, stateReason: true, storagePath: true,
                    createdById: true, expectedSha256: true, fileSha256: true,
                    uploadLeaseVersion: true, uploadUrlExpiresAt: true,
                },
            });
            if (!existing) return NextResponse.json({ ok: false, reason: "conflict-retry" }, { status: 409 });
            const maySee =
                auth.via === "secret" ||
                existing.createdById === auth.user.id ||
                auth.user.role === "ADMIN";
            if (!maySee) return NextResponse.json({ ok: false, error: "sourceRef-conflict" }, { status: 409 });

            // A ROW THE SWEEPER PARKED AS RECOVERABLE GETS A NEW URL, NOT
            // "alreadyReceived".
            //
            // file-missing and sha-mismatch both mean the bytes we hold RIGHT
            // NOW are not the document (or are not there at all), and the row
            // never published. Answering alreadyReceived told the forwarder we
            // had a receipt we did not have — and it deletes its only copy on
            // that answer — leaving the row parked forever with nothing to
            // recover from. So the upload is re-armed instead: a fresh signed
            // URL, and the sha the caller is about to upload becomes the
            // expected one.
            //
            // BUT a row can be "recoverable" and still remember a REAL,
            // previously verified identity — file-missing in particular is
            // reached from a row that was already published (RECEIVED) and
            // later found to have lost its object; its fileSha256 records the
            // document that was actually published, not a stale guess. A
            // recovery must not silently rebind that identity to different
            // bytes: skipping the check entirely (as before) let a receipt
            // published once, then physically lost, be "recovered" with an
            // entirely unrelated document. Only a row with NO recorded hash at
            // all (nothing to protect) may rearm without proving identity.
            //
            // "RECORDED" MEANS `fileSha256`, AND ONLY `fileSha256`.
            //
            // That column is written by the seal, from the bytes actually in
            // the bucket — it is the one hash this system has ever verified,
            // and the only one that can describe a document a human or
            // QuickBooks has seen. `expectedSha256` is the opposite: a promise
            // a client made about bytes it was ABOUT to upload, and on a
            // recoverable park that promise is precisely what was never kept.
            //
            // OR-ing the two in bricked the recovery it was guarding. Both
            // recoverable parks are reachable from STAGING, where `fileSha256`
            // is "" — so the announced-but-unuploaded hash became the identity
            // to protect, and a forwarder coming back with a corrected hash
            // (a re-scanned Drive file, a recomputed digest) got 409 forever on
            // a sourceRef that had never held a document at all. Nothing can
            // be overwritten by narrowing it: a rearm writes to a NEW lease
            // path, clears `fileSha256`, and leaves the row parked until
            // /finalize verifies the bytes that actually land.
            const recoverable = existing.state !== "STAGING"
                && finalizeDisposition(existing) === "publish";
            if (recoverable) {
                const verifiedSha = (existing.fileSha256 || "").toLowerCase();
                if (verifiedSha && verifiedSha !== expectedSha256) {
                    return NextResponse.json(
                        {
                            ok: false,
                            error: "sourceRef-conflict",
                            reason: "this sourceRef's previously recorded document has a different hash; it cannot be rebound to different bytes",
                            existingId: existing.id,
                        },
                        { status: 409 },
                    );
                }
                // A LIVE LEASE IS NOT INVALIDATED BY A RETRY HERE EITHER.
                //
                // The re-arm below is destructive by design — new version, new
                // path, the old object deleted — and it used to run on EVERY
                // /start for a recoverable row, including one whose signed URL
                // was still live. Two retries for the same parked sourceRef (a
                // forwarder's own retry policy, a double-tap) therefore raced:
                // the second deleted the object the first was about to PUT its
                // bytes to, and the first request's URL pointed at nothing.
                // Same failure the STAGING path was fixed for; the rule is one
                // rule now (see reuseLiveLease).
                //
                // The re-arm's identity writes still happen, because a recovery
                // may legitimately arrive with a CORRECTED expected hash — they
                // just land on the SAME path and the SAME lease version.
                const keptRecovery = await reuseLiveLease(existing, ext, leaseDeps, {
                    expectedSha256,
                    fileSha256: "",
                    mimeType,
                    fileSize: 0,
                    nextRetryAt: null,
                });
                if (keptRecovery) {
                    if (keptRecovery.kind === "storage-unavailable") {
                        return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
                    }
                    if (keptRecovery.kind === "conflict") return leaseConflict(existing.id);
                    return NextResponse.json({
                        ok: true,
                        resumed: true,
                        recovered: true,
                        id: existing.id,
                        state: existing.state,
                        maxBytes: MAX_STORED_BYTES,
                        ...keptRecovery.signed,
                    });
                }

                // THE ROW MOVES FIRST, THEN THE URL IS SIGNED.
                //
                // The claim on the lease is made in ONE checked update: the
                // version goes up, the expiry is refreshed, and the row is
                // re-pointed at the path that version names. Signing first and
                // writing after left a window where a sweep could reject the
                // row for the OLD upload while a URL for the new one was
                // already in the client's hands.
                const nextLease = existing.uploadLeaseVersion + 1;
                const retryPath = uploadPathFor(existing.id, nextLease, ext);
                const { count } = await prisma.receiptIntake.updateMany({
                    where: { id: existing.id, ...publishFence(existing) },
                    data: {
                        storagePath: retryPath,
                        expectedSha256,
                        uploadUrlExpiresAt: uploadLeaseExpiry(),
                        uploadLeaseVersion: nextLease,
                        // Same generation stamp every adoption writes, so a
                        // concurrent discard can never mistake this row for
                        // the lease it created.
                        uploadLeaseNonce: newLeaseNonce(),
                        // The stored hash is what /finalize verifies against.
                        // Whatever was recorded describes bytes that are gone
                        // or were never right.
                        fileSha256: "",
                        mimeType,
                        fileSize: 0,
                        nextRetryAt: null,
                    },
                });
                if (count === 0) {
                    return leaseConflict(existing.id);
                }
                // THE OLD OBJECT IS UNREFERENCED THE INSTANT THE CAS LANDS —
                // so it is cleaned up here, BEFORE the signing that may fail,
                // rather than after it.
                //
                // The row moves first on purpose (see above), which means the
                // previous path is orphaned whether or not a URL is ever
                // issued for the new one. Doing the cleanup only on the happy
                // path left every 503 below leaking an object nothing
                // referenced and nothing remembered: not the row (it points
                // elsewhere now), not the stale-STAGING sweep (it looks at
                // rows), not the cleanup queue (nobody had recorded it).
                // deleteObjectOrRecord is exactly the guarded path for this —
                // it deletes, and records a pending cleanup when the delete
                // fails.
                if (retryPath !== existing.storagePath) {
                    await deleteObjectOrRecord(existing.storagePath, "start-rearmed-repath");
                }
                const rearmed = await signUpload(retryPath);
                if (!rearmed) {
                    // The row keeps the NEW path and a live expiry, so the
                    // caller's retry lands in reuseLiveLease and is handed a
                    // URL over that same path. Nothing is orphaned by the
                    // failure itself.
                    return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
                }
                return NextResponse.json({
                    ok: true,
                    resumed: true,
                    recovered: true,
                    id: existing.id,
                    state: existing.state,
                    maxBytes: MAX_STORED_BYTES,
                    ...rearmed,
                });
            }

            // IDENTITY MUST BE PROVEN BEFORE AN UPSERT URL IS REISSUED.
            //
            // The URL is `upsert: true` so a caller can replace its OWN partial
            // upload — which is exactly why handing one out for an existing path
            // requires proof this is the same document. A mismatching or
            // unknown-identity request would otherwise get a URL that
            // overwrites receipt A with receipt B, and only /finalize would
            // notice, by which point A's bytes are gone.
            const knownSha = (existing.fileSha256 || existing.expectedSha256 || "").toLowerCase();
            if (!knownSha || knownSha !== expectedSha256) {
                return NextResponse.json(
                    {
                        ok: false,
                        error: "sourceRef-conflict",
                        reason: knownSha
                            ? "this sourceRef already holds a different document"
                            : "this sourceRef exists with no recorded hash; identity cannot be proven",
                        existingId: existing.id,
                    },
                    { status: 409 },
                );
            }

            if (existing.state !== "STAGING") {
                // "We already have it" has to be TRUE: the forwarder deletes its
                // only copy on this answer.
                //
                // PRESENCE WAS NOT TRUTH. This branch used to ask storage for a
                // SIZE and answer alreadyReceived on anything that came back, so
                // the sender was authorised to destroy its copy on the strength
                // of bytes nobody had looked at since they were sealed. An
                // object replaced or corrupted after publication — the upload
                // URL is `upsert: true`, a restore can put back a different
                // version, storage can fault — was laundered into "we hold your
                // receipt" and the last good copy went with it. The row's
                // `fileSha256` is the only hash this system has ever verified;
                // the stored bytes must still hash to it.
                //
                // ONE rule, shared with the other two replay paths (POST
                // /intake and /intake/{id}/finalize, see stored-object.ts), so
                // the three cannot come to disagree about what "we already have
                // it" means. The cheap metadata probe still runs first inside
                // it, so the common orphan case never pays for a download.
                const held = await verifyStoredCopy(existing.storagePath, existing.fileSha256);
                if (!held.ok && held.kind === "transient") {
                    // Storage could not answer. That is never evidence about the
                    // bytes, so it is never a verdict: the sender retries with
                    // its copy intact.
                    return NextResponse.json(
                        { ok: false, reason: "verify-unavailable", retryable: true },
                        { status: 503 },
                    );
                }
                if (!held.ok && held.kind === "content-mismatch") {
                    // NOT healed, and never a 2xx. A re-upload is exactly how
                    // bytes get replaced, so healing here would let a replay
                    // launder the swap. The row is left exactly as it is for the
                    // worker's `content-changed` park and the sweeper to act on.
                    return NextResponse.json(
                        {
                            ok: false,
                            error: "content-mismatch",
                            reason: "the stored document is not the one this row was published with; keep your copy and escalate",
                            retryable: false,
                            existingId: existing.id,
                            state: existing.state,
                        },
                        { status: 409 },
                    );
                }
                if (!held.ok) {
                    // A settled row with no object. Recovering it is not this
                    // endpoint's job — /start hands out an upload URL for rows
                    // that are still STAGING or recoverably parked, and dragging
                    // a BOOKED row back would rewrite a receipt behind a
                    // Purchase. A 409 the sender can act on, never a 2xx.
                    return NextResponse.json(
                        {
                            ok: false,
                            error: "file-missing",
                            reason: "this sourceRef exists but its stored document is gone; escalate",
                            retryable: true,
                            existingId: existing.id,
                            state: existing.state,
                        },
                        { status: 409 },
                    );
                }
                return NextResponse.json(
                    { ok: true, alreadyReceived: true, id: existing.id, state: existing.state },
                );
            }
            // A LIVE LEASE IS NOT INVALIDATED BY A RETRY. Same rule, same
            // helper, as the recoverable re-arm above.
            const kept = await reuseLiveLease(existing, ext, leaseDeps);
            if (kept) {
                if (kept.kind === "storage-unavailable") {
                    return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
                }
                if (kept.kind === "conflict") return leaseConflict(existing.id);
                return NextResponse.json({
                    ok: true, resumed: true, id: existing.id, maxBytes: MAX_STORED_BYTES, ...kept.signed,
                });
            }

            // A RESUME IS A NEW LEASE, taken BEFORE the URL is signed and in one
            // checked update. Without the version bump the sweep and the client
            // are talking about the same path, so a sweep that started before
            // this call could still reject the upload it is now waiting for.
            // Reached only once the previous lease has EXPIRED (or this is a
            // fresh STAGING row with no lease yet) — an expired lease is fair
            // game to invalidate, since nothing live can still be relying on it.
            const nextLease = existing.uploadLeaseVersion + 1;
            const resumePath = uploadPathFor(existing.id, nextLease, ext);
            const { count } = await prisma.receiptIntake.updateMany({
                where: {
                    id: existing.id,
                    state: "STAGING",
                    uploadLeaseVersion: existing.uploadLeaseVersion,
                },
                data: {
                    storagePath: resumePath,
                    uploadLeaseVersion: nextLease,
                    uploadUrlExpiresAt: uploadLeaseExpiry(),
                    uploadLeaseNonce: newLeaseNonce(),
                },
            });
            if (count === 0) return leaseConflict(existing.id);
            // BEFORE the signing, for the same reason as the re-arm above: the
            // CAS already re-pointed the row, so the previous lease's object is
            // unreferenced whatever the signer does next. Cleaning up only on
            // success meant a 503 here left it in the bucket with nothing
            // pointing at it and nothing remembering it.
            if (resumePath !== existing.storagePath) {
                await deleteObjectOrRecord(existing.storagePath, "start-resumed-repath");
            }
            const resumed = await signUpload(resumePath);
            // The row is on the new path with a live expiry, so a retry resumes
            // through reuseLiveLease over that same path.
            if (!resumed) return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
            return NextResponse.json({
                ok: true, resumed: true, id: existing.id, maxBytes: MAX_STORED_BYTES, ...resumed,
            });
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
            return NextResponse.json({ ok: false, reason: "unknown-project-or-cost-code" }, { status: 400 });
        }
        throw error;
    }

    const signed = await signUpload(storagePath);
    if (!signed) {
        // THE ROW ONLY GOES IF NOBODY ELSE ADOPTED IT.
        //
        // Creating the row and signing its URL are two steps, and a concurrent
        // /start for the same sourceRef can complete BOTH of its own steps in
        // the gap: it hits the unique violation, finds this row with a live
        // lease, and reuseLiveLease hands it a working URL over this very path.
        // The unconditional delete this replaces then removed the row that
        // retry had just adopted — its bytes landed at a path no row pointed
        // at, /finalize 404d on an id that no longer existed, and the
        // sourceRef stopped protecting anything. See discardUnresumedLease for
        // the columns the CAS reads and why the expiry alone could NOT see the
        // reuse: an adoption writes "now + 2h" exactly as this request did, so
        // the two can be the same millisecond. `leaseNonce` is what actually
        // identifies this request's lease.
        //
        // Still best effort, exactly as before: a cleanup that could not run at
        // all leaves a STAGING row with no object, which the stale-STAGING
        // sweep already knows how to park. It never leaves a row deleted.
        const discarded = await discardUnresumedLease(
            {
                id,
                storagePath,
                uploadLeaseVersion: 1,
                uploadUrlExpiresAt: leaseExpiresAt,
                uploadLeaseNonce: leaseNonce,
            },
            prisma.receiptIntake,
        ).catch(() => null);
        if (discarded === "resumed") {
            // Somebody else owns this row and their URL works. Reporting our
            // own signer failure would tell a client to retry a row that is
            // alive and in good hands; the idempotent conflict says who to ask.
            return leaseConflict(id);
        }
        return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
    }

    return NextResponse.json({
        ok: true,
        id: created.id,
        sourceRef: created.sourceRef,
        state: created.state,
        maxBytes: MAX_STORED_BYTES,
        ...signed,
    });
}

function leaseConflict(existingId: string) {
    return NextResponse.json(
        {
            ok: false,
            error: "publish-conflict",
            reason: "this row changed while a new upload URL was being issued; retry",
            retryable: true,
            existingId,
        },
        { status: 409 },
    );
}

/** The live wiring for the shared lease rule (src/lib/receipt-intake/upload-lease.ts). */
const leaseDeps = {
    db: prisma.receiptIntake,
    sign: (storagePath: string) => signUpload(storagePath),
    expiresAt: uploadLeaseExpiry,
};

/**
 * The URL is `upsert: true` (see bucket.ts) so a resumed /start for the SAME
 * row can replace its own partial upload — without that the second attempt
 * fails "already exists" and the row can never be finalized. The sha checks
 * above are what stop it from overwriting a DIFFERENT document.
 */
const signUpload = createReceiptUploadUrl;
