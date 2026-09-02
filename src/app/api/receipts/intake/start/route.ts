import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { captureActorSource, optionalBool } from "@/lib/receipt-capture-validation";
import { SECURE_BUCKET } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";
import { authenticateIntake } from "@/lib/receipt-intake/intake-auth";
import { ACCEPTED_MIME_TYPES, EXT_BY_MIME } from "@/lib/receipt-intake/file-type";
import { decideSource, MAX_STORED_BYTES } from "@/lib/receipt-intake/intake-core";
import { uploadLeaseExpiry } from "@/lib/receipt-intake/worker";
import { authorizePhase } from "@/lib/receipt-intake/late-fields";
import { finalizeDisposition, publishFence, uploadPathFor } from "@/lib/receipt-intake/stored-object";
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
                costCodeSource: costCodeId ? captureActorSource(auth.via) : null,
                // Tri-state, and nothing defaults it: silence is "nobody said",
                // which is never claimed on the excise return.
                installedAtCustomer: optionalBool(body.installedAtCustomer),
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
                uploadUrlExpiresAt: uploadLeaseExpiry(),
                uploadLeaseVersion: 1,
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
                    uploadLeaseVersion: true,
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
            // file-missing and sha-mismatch both mean the bytes we hold are not
            // the document (or are not there at all), and the row never
            // published. Answering alreadyReceived told the forwarder we had a
            // receipt we did not have — and it deletes its only copy on that
            // answer — leaving the row parked forever with nothing to recover
            // from. So the upload is re-armed instead: a fresh signed URL, and
            // the sha the caller is about to upload becomes the expected one.
            //
            // The identity check below is deliberately skipped for these two:
            // it exists to stop receipt B overwriting receipt A's VERIFIED
            // bytes, and here there are none to protect.
            const recoverable = existing.state !== "STAGING"
                && finalizeDisposition(existing) === "publish";
            if (recoverable) {
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
                    return NextResponse.json(
                        {
                            ok: false,
                            error: "publish-conflict",
                            reason: "this row changed while a new upload URL was being issued; retry",
                            retryable: true,
                            existingId: existing.id,
                        },
                        { status: 409 },
                    );
                }
                const rearmed = await signUpload(retryPath);
                if (!rearmed) {
                    return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
                }
                // The previous lease's object (if any) is unreferenced now.
                if (retryPath !== existing.storagePath) {
                    await deleteObjectOrRecord(existing.storagePath, "start-rearmed-repath");
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
                return NextResponse.json(
                    { ok: true, alreadyReceived: true, id: existing.id, state: existing.state },
                );
            }
            // A RESUME IS A NEW LEASE, taken BEFORE the URL is signed and in one
            // checked update. Without the version bump the sweep and the client
            // are talking about the same path, so a sweep that started before
            // this call could still reject the upload it is now waiting for.
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
                },
            });
            if (count === 0) {
                return NextResponse.json(
                    {
                        ok: false,
                        error: "publish-conflict",
                        reason: "this row changed while a new upload URL was being issued; retry",
                        retryable: true,
                        existingId: existing.id,
                    },
                    { status: 409 },
                );
            }
            const resumed = await signUpload(resumePath);
            if (!resumed) return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
            if (resumePath !== existing.storagePath) {
                await deleteObjectOrRecord(existing.storagePath, "start-resumed-repath");
            }
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
        await prisma.receiptIntake.delete({ where: { id } }).catch(() => { /* best effort */ });
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

/**
 * The URL is `upsert: true` (see bucket.ts) so a resumed /start for the SAME
 * row can replace its own partial upload — without that the second attempt
 * fails "already exists" and the row can never be finalized. The sha checks
 * above are what stop it from overwriting a DIFFERENT document.
 */
const signUpload = createReceiptUploadUrl;
