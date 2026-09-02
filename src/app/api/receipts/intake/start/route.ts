import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCanAccessProject } from "@/lib/mobile-auth";
import { SECURE_BUCKET } from "@/lib/secure-storage";
import { getSupabase } from "@/lib/supabase";
import { authenticateIntake } from "@/lib/receipt-intake/intake-auth";
import { EXT_BY_MIME } from "@/lib/receipt-intake/file-type";
import { decideSource, MAX_STORED_BYTES } from "@/lib/receipt-intake/intake-core";

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

    const mimeType = String(body.mimeType ?? "").split(";")[0].trim().toLowerCase();
    const ext = EXT_BY_MIME[mimeType];
    // The declared mime only picks the extension here; /finalize re-derives the
    // real type from the STORED BYTES, so a lie costs the caller its upload.
    if (!ext) return NextResponse.json({ ok: false, reason: "unsupported-file-type" }, { status: 400 });

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

    const id = randomUUID();
    const storagePath = `receipts/intake/${id}.${ext}`;

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
                costCodeId: str(body.costCodeId),
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
                    id: true, sourceRef: true, state: true, storagePath: true,
                    createdById: true, expectedSha256: true, fileSha256: true,
                },
            });
            if (!existing) return NextResponse.json({ ok: false, reason: "conflict-retry" }, { status: 409 });
            const maySee =
                auth.via === "secret" ||
                existing.createdById === auth.user.id ||
                auth.user.role === "ADMIN";
            if (!maySee) return NextResponse.json({ ok: false, error: "sourceRef-conflict" }, { status: 409 });

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
            const resumed = await signUpload(existing.storagePath);
            if (!resumed) return NextResponse.json({ ok: false, reason: "storage-unavailable" }, { status: 503 });
            return NextResponse.json({ ok: true, resumed: true, id: existing.id, ...resumed });
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

async function signUpload(storagePath: string): Promise<{ uploadUrl: string; token: string; storagePath: string } | null> {
    const supabase = getSupabase();
    if (!supabase) return null;
    try {
        // upsert: true — a resumed /start for the SAME row must be able to
        // overwrite a partial or failed upload at the same path. Without it the
        // second attempt fails on "already exists" and the row can never be
        // finalized. The sha checks above are what stop this from overwriting a
        // DIFFERENT document.
        const { data, error } = await supabase.storage
            .from(SECURE_BUCKET)
            .createSignedUploadUrl(storagePath, { upsert: true });
        if (error || !data) {
            console.error("[receipts/intake/start] sign failed", error?.message);
            return null;
        }
        return { uploadUrl: data.signedUrl, token: data.token, storagePath };
    } catch (error) {
        console.error("[receipts/intake/start] sign threw", error instanceof Error ? error.name : "error");
        return null;
    }
}
