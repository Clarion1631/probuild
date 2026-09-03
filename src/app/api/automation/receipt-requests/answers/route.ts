import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateBridge } from "@/lib/receipt-intake/intake-auth";
import { evaluateReviewIssue } from "@/lib/review-alert-lifecycle";
import {
    RECEIPT_REQUEST_TARGET_TYPE,
    bankLineIdFromFingerprint,
    driveFileIdFromUrl,
    hasResolution,
    isDurableArtifactUrl,
} from "@/lib/receipt-requests";
import { isDriveFileId, probeDriveFile } from "@/lib/google-drive";
import { parseMissingReceiptDetails } from "@/app/automation/receipts-data";

export const dynamic = "force-dynamic";

/**
 * The `chat-job-answers.json` bridge, other direction (Phase 2 §4 "close the
 * loop"). A qbo-clasp forwarder posts each NEW record from that file here.
 *
 * We handle exactly one kind: a SIGNED memo against one of our own
 * fingerprints (`pb-<bankLineId>`). That closes the chase, because a signed
 * affidavit IS the evidence when no merchant receipt exists.
 *
 * Photo and job-name answers deliberately need nothing here: the resulting
 * Expense or ReceiptIntake closes the issue through the nightly matcher, which
 * is the one place that decides whether evidence exists. A second closing path
 * would be a second truth.
 *
 * Beverly mints her own fingerprints for her own asks. Those are answered with
 * `{ok:true, ignored:true}` — not an error. The forwarder ships one file for
 * both systems and must not retry forever on rows that were never ours.
 *
 * NEVER emails anything, and never downloads the PDF: it reads the file's
 * METADATA to prove it exists, then records the id and a link. A `signed:true`
 * with no `pdf_id`, or one naming a file Drive says is not there, writes
 * nothing (422); a Drive we cannot reach is a 503 with `retry`, never a
 * recorded resolution.
 *
 * AUTH: the Phase 1 machine secret, fail-closed. Exact-match proxy bypass, so
 * the caller gets a clean 401 rather than a redirect. No session branch exists.
 */

interface AnswerBody {
    fingerprint?: unknown;
    signed?: unknown;
    /** The affidavit app's Drive file id. REQUIRED for a signature. */
    pdf_id?: unknown;
    /** Optional convenience link. Never the proof — see the artifact block. */
    pdf_url?: unknown;
    job?: unknown;
    at?: unknown;
    message?: unknown;
    thread?: unknown;
}

/** A stored URL is display data; cap it so a stray blob cannot bloat the row. */
const MAX_URL_LEN = 2_000;

/**
 * The affidavit generator's own naming contract
 * (PHASE-2-QUEUE-AND-MEMOS-SPEC.md §"Sign flow", verified against
 * `chatAffidavitApp.js:524-573` — a SEPARATE Apps Script repo this route
 * cannot change): `MissingReceiptAffidavit_<date>_<vendor>_<amount>_<name>.pdf`.
 * It carries no fingerprint or bank-line id — Beverly's app never sees either
 * — so the strongest binding available without touching that external script
 * is the DOLLAR AMOUNT field, parsed out at its own fixed position (the third
 * underscore-delimited segment after the prefix) rather than searched for as
 * a substring: `name.includes("12.34")` let a memo named "...112.34..." or
 * "...12.345..." satisfy a $12.34 charge, because the target digits are a
 * substring of a DIFFERENT amount too — prefix or suffix, either way a wrong
 * charge (Codex PR #443 gate round 2 — round 1's fix reintroduced the exact
 * bug it closed, in string form).
 */
const AFFIDAVIT_NAME_PREFIX = "MissingReceiptAffidavit_";

/** The amount field's own shape: digits, a point, exactly two decimal digits. */
const AFFIDAVIT_AMOUNT_FIELD_RE = /^(\d+)\.(\d{2})$/;

/**
 * The amount FIELD, as cents — not a substring search. `<date>_<vendor>_
 * <amount>_<name...>.pdf`: date and vendor are always exactly the first two
 * fields (the sign flow's own contract), so the amount is always the third,
 * regardless of how many underscores the trailing name carries. Anything
 * that is not exactly two decimal digits (a truncated OR padded amount) is
 * not a parse failure to shrug off — it is the exact shape a wrong-charge
 * memo takes — so it returns null rather than guessing.
 */
function affidavitAmountFieldCents(name: string): number | null {
    const fields = name.slice(AFFIDAVIT_NAME_PREFIX.length).split("_");
    if (fields.length < 4) return null;
    const match = AFFIDAVIT_AMOUNT_FIELD_RE.exec(fields[2]);
    if (!match) return null;
    return Number(match[1]) * 100 + Number(match[2]);
}

/**
 * True when a probed Drive filename could plausibly BE the signed memo for
 * THIS charge, rather than some other PDF the bridge secret happens to be
 * able to read.
 *
 * `signed:true` plus a Drive id that merely EXISTS used to be enough to close
 * a chase — nothing tied the artifact to the charge it claims to answer
 * (Codex PR #443 gate, finding 3). Not exact-format verification — Beverly's
 * vendor/date sanitization is not this route's to pin down — but the amount
 * FIELD, parsed out and compared as an exact number of cents, is specific
 * enough that a PDF minted for a different amount cannot carry it, and a
 * file with the wrong prefix was never produced by the sign flow at all.
 */
function affidavitNameMatchesIssue(name: string | null, amountCents: number): boolean {
    if (!name) return false;
    if (!name.toLowerCase().endsWith(".pdf")) return false;
    if (!name.startsWith(AFFIDAVIT_NAME_PREFIX)) return false;
    const fieldCents = affidavitAmountFieldCents(name);
    return fieldCents !== null && fieldCents === Math.abs(amountCents);
}

/**
 * A card asked about this item at least once — the `cards[]` (or legacy
 * `card`) history `recordCardOnIssues` appends when a chase card lists it
 * (`receipt-request-cards.ts`). Every card offers "sign N" alongside a photo
 * or a job name, so an item that was never carded never had that option to
 * begin with: a signature for one did not come from anything WE sent.
 */
function hasRecordedMemoRequest(details: Record<string, unknown>): boolean {
    const cards = details.cards;
    if (Array.isArray(cards) && cards.length > 0) return true;
    return details.card !== undefined && details.card !== null;
}

/**
 * True when this Drive file is already recorded as the memo-signed evidence
 * on a DIFFERENT bank-line issue. One signed affidavit answers exactly one
 * charge; accepting it a second time is how a single memo silently closes two
 * chases.
 *
 * Takes a TRANSACTION CLIENT, not the module-level `prisma` — this is now
 * always called from inside the pdfId's advisory-locked transaction (see
 * POST), so the read is against the same connection that holds the lock and
 * will perform the write. A plain `prisma.*` read here used to run OUTSIDE
 * any lock, so two concurrent signatures for the same pdfId could both read
 * "not reused yet" before either had written (Codex round-2 gate).
 */
async function pdfIdReusedElsewhere(
    tx: Prisma.TransactionClient,
    pdfId: string,
    ownTargetKey: string,
): Promise<boolean> {
    const candidates = await tx.reviewIssue.findMany({
        where: {
            targetType: RECEIPT_REQUEST_TARGET_TYPE,
            targetKey: { not: ownTargetKey },
            // Coarse pre-filter — displayDetails is TEXT, so the parsed field
            // cannot be queried directly. Verified exactly below.
            displayDetails: { contains: pdfId },
        },
        select: { displayDetails: true },
    });
    return candidates.some(row => {
        const details = parseMissingReceiptDetails(row.displayDetails);
        return hasResolution(details) && details.pdfId === pdfId;
    });
}

export async function POST(request: Request) {
    // RECEIPT_BRIDGE_SECRET, not the intake key — see the threads route.
    const auth = authenticateBridge(request);
    if (!auth.ok) return auth.response;

    let bodyUnknown: unknown;
    try {
        bodyUnknown = await request.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (bodyUnknown === null || typeof bodyUnknown !== "object" || Array.isArray(bodyUnknown)) {
        return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
    }
    const body = bodyUnknown as AnswerBody;

    if (typeof body.fingerprint !== "string" || !body.fingerprint.trim()) {
        return NextResponse.json({ ok: false, reason: "invalid-fingerprint" }, { status: 400 });
    }
    const bankLineId = bankLineIdFromFingerprint(body.fingerprint.trim());
    if (!bankLineId) {
        return NextResponse.json({ ok: true, ignored: true });
    }

    // Only a signed memo resolves anything here. Everything else is recorded
    // by the sweep and answered by the matcher.
    if (body.signed !== true) {
        return NextResponse.json({ ok: true, ignored: true, reason: "not-a-signature" });
    }

    /**
     * AN UNKNOWN TARGET IS IGNORED BEFORE ANYTHING ELSE IS REQUIRED OF THE
     * BODY. A fingerprint shaped like ours (`pb-<bankLineId>`) but naming a
     * line whose issue was never created, or was deleted, is not an error the
     * forwarder should be told to fix by resending a "more complete" body —
     * there is nothing here to complete. Checked before `pdf_id`/Drive so a
     * malformed or partial record for a target that does not exist reads the
     * same as one that does: ignored, never retried forever.
     */
    const targetIssue = await prisma.reviewIssue.findUnique({
        where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: bankLineId } },
        select: { id: true },
    });
    if (!targetIssue) {
        return NextResponse.json({ ok: true, ignored: true, reason: "unknown-target" });
    }

    /**
     * A SIGNATURE WITHOUT A VERIFIED ARTIFACT IS NOT EVIDENCE.
     *
     * `signed:true` alone used to close the chase, so a truncated forwarder row
     * silenced a genuinely missing receipt and left nothing a human could open.
     * A URL was the next attempt and it is still not proof: a well-formed link
     * to a file that was never created, or was created and deleted, passes
     * every syntactic check there is.
     *
     * So the bridge sends the affidavit app's Drive FILE ID, and this reads its
     * metadata before recording anything. Three outcomes, three different
     * answers, and the difference is the point:
     *
     *   found       — record the resolution and clear the chase.
     *   missing     — 422. Google answered and there is no such file (or it is
     *                 in the bin). Retrying will not change that; the memo has
     *                 to be re-generated. The chase stays open.
     *   unreachable — 503. We could not ASK. Nothing is written, and the
     *                 forwarder is told to come back: "we could not check" must
     *                 never be recorded as "it checked out".
     */
    if (!isDriveFileId(body.pdf_id)) {
        return NextResponse.json(
            { ok: false, reason: "missing-artifact", detail: "a signed memo must carry its Drive pdf_id", targetKey: bankLineId },
            { status: 422 },
        );
    }
    const pdfId = (body.pdf_id as string).trim();
    const probe = await probeDriveFile(pdfId);
    if (probe.kind === "unreachable") {
        // NO CREDENTIAL is its own answer, and a different problem from a bad
        // minute at Google: it means this deployment cannot verify ANY memo
        // until somebody connects Drive, and it will not fix itself. Naming it
        // is what stops the retries reading as a transient Google outage —
        // pipeline-health reports the same condition as `drive-not-configured`.
        const unconfigured = probe.reason === "no-drive-token";
        console.error(
            unconfigured
                ? "[automation/receipt-requests/answers] Drive is NOT CONFIGURED — no memo can be verified"
                : "[automation/receipt-requests/answers] Drive unreachable",
            pdfId, probe.reason,
        );
        return NextResponse.json(
            {
                ok: false,
                reason: unconfigured ? "drive-not-configured" : "artifact-unverifiable",
                retry: true,
                detail: probe.reason,
                targetKey: bankLineId,
            },
            { status: 503 },
        );
    }
    if (probe.kind === "missing") {
        return NextResponse.json(
            { ok: false, reason: "artifact-missing", detail: probe.reason, targetKey: bankLineId },
            { status: 422 },
        );
    }
    // FOUND IS NOT ENOUGH — it only proves Drive has an object at that id, not
    // that the object is the signed memo it claims to be. Any Drive object
    // (a folder, an image, a Doc) passed `found` before this check, and this
    // route recorded `memo-signed` for it regardless. The chase stays open
    // until the bridge sends the real PDF.
    if (probe.mimeType !== "application/pdf") {
        return NextResponse.json(
            { ok: false, reason: "not-a-pdf", detail: probe.mimeType ?? "unknown", targetKey: bankLineId },
            { status: 422 },
        );
    }
    /**
     * THE LINK MUST NAME THE FILE WE JUST VERIFIED.
     *
     * `pdf_id` is proved against Drive; `pdf_url` was not proved against
     * anything. Storing the caller's link merely because it was durable-looking
     * meant the id and the URL need never describe the same object — the id
     * passes the probe, and the link a human actually clicks a year later can
     * point somewhere else entirely. So the caller's URL is accepted only when
     * the file id inside it IS `pdfId`; otherwise the probed `webViewLink`,
     * which came from the verification itself, is what gets stored.
     */
    const callerUrl = isDurableArtifactUrl(body.pdf_url) && driveFileIdFromUrl(body.pdf_url) === pdfId
        ? (body.pdf_url as string).slice(0, MAX_URL_LEN)
        : null;
    const artifactUrl = callerUrl ?? probe.webViewLink ?? null;

    // RECORD FIRST, CLEAR ONLY IF IT COMMITTED.
    //
    // This used to clear the issue even when its details CAS lost — leaving a
    // cleared issue with NO resolution, which the next nightly sweep read as
    // "still unmatched" and reopened. The memo the owner signed changed
    // nothing. So: read fresh, merge, write version-guarded, and retry ONCE
    // from another fresh read if a concurrent writer moved the row. Only a
    // committed resolution earns the clear.
    let recorded: { targetKey: string } | null = null;
    let alreadyCleared = false;
    /** The card-history race: answered already, and never carrying a record of the ask. */
    let alreadyResolved = false;
    let missing = false;
    let neverRequested = false;
    let mismatch = false;
    let reused = false;

    type AttemptOutcome =
        | { kind: "missing" }
        | { kind: "reused" }
        | { kind: "never-requested" }
        | { kind: "mismatch" }
        | { kind: "recorded"; alreadyCleared: boolean; alreadyResolved: boolean }
        | { kind: "lost-race" };

    for (let attempt = 0; attempt < 2 && !recorded && !alreadyCleared && !missing && !neverRequested && !mismatch && !reused; attempt++) {
        const outcome: AttemptOutcome = await prisma.$transaction(async tx => {
            /**
             * THE PDF-ID LOCK — taken BEFORE the reuse check, and held through
             * the write, on EVERY attempt (not just the first).
             *
             * The reuse check used to be a plain read outside any lock, and
             * only ran on attempt 0: two concurrent signatures naming the SAME
             * pdfId against two DIFFERENT charges could both read "not reused
             * yet" before either had written, and a lost-race retry skipped
             * the check entirely, so the SECOND attempt of a losing request
             * could still record a reuse the check exists to catch (Codex
             * round-2 gate). One transaction-scoped advisory lock per pdfId,
             * held across the read-check-write here, is what makes "not
             * reused" a fact rather than a guess: a second writer for the same
             * file blocks on this line until the first commits, and then sees
             * its resolution.
             */
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`memo-pdf:${pdfId}`}))`;

            const issue = await tx.reviewIssue.findUnique({
                where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: bankLineId } },
                select: { id: true, version: true, displayDetails: true, clearedAt: true },
            });
            if (!issue) return { kind: "missing" };

            // THE ARTIFACT MUST BE BOUND TO THIS CHARGE, not merely
            // accessible. A caller-supplied fingerprint plus any readable
            // Drive PDF used to be enough to close a chase: nothing checked
            // that this item was ever actually asked about, that the file was
            // minted FOR it, or that the SAME file was not already spent
            // answering a different one (Codex PR #443 gate, finding 3).
            if (await pdfIdReusedElsewhere(tx, pdfId, bankLineId)) return { kind: "reused" };

            // Merged from THIS read, not from anything older: a card record or
            // a corrected amount written since must survive.
            const details = parseMissingReceiptDetails(issue.displayDetails);

            // NO RECORD OF THE ASK, on an issue that is ALREADY ANSWERED, is
            // the card-history race — not an unrequested memo (Codex PR #443
            // gate, finding 2). The card went out, the issue cleared before its
            // thread record was written, and the person who then signed the
            // memo in that thread got a 422 telling them nobody had asked. The
            // ask is not in doubt here: the issue exists, it is resolved, and
            // the artifact still has to match it. So this is reported as the
            // idempotent success it is, and the memo is recorded exactly as it
            // would be on any other cleared issue — nothing is CLOSED by it,
            // because it is closed already.
            const requested = hasRecordedMemoRequest(details);
            if (!requested && issue.clearedAt === null) return { kind: "never-requested" };
            const amountCents = typeof details.amountCents === "number" ? details.amountCents : null;
            if (amountCents === null || !affidavitNameMatchesIssue(probe.name, amountCents)) {
                // Checked BEFORE the already-resolved answer below, so a memo
                // for a DIFFERENT charge can never be waved through as "already
                // resolved" just because this issue happens to be closed.
                return { kind: "mismatch" };
            }

            details.resolution = "memo-signed";
            // The ID is the durable identity; the URL is how a human opens it.
            details.pdfId = pdfId;
            if (artifactUrl) details.pdfUrl = artifactUrl;
            if (typeof body.at === "string") details.signedAt = body.at.slice(0, 64);
            if (typeof body.thread === "string") details.signedThread = body.thread.slice(0, 200);

            // RECORDED EVEN ON A CLEARED ISSUE (Codex round-4 item 3).
            //
            // A memo signed after the nightly matcher had already auto-closed
            // the line used to be discarded — so when the matching receipt was
            // later deleted, the sweep reopened a charge somebody had
            // genuinely answered weeks earlier. A valid signature is evidence
            // whatever the issue's current state, and `resolution` is exactly
            // the field the matcher reads to suppress a reopen.
            const written = await tx.reviewIssue.updateMany({
                where: { id: issue.id, version: issue.version },
                data: { displayDetails: JSON.stringify(details), version: { increment: 1 } },
            });
            if (written.count === 1) {
                return {
                    kind: "recorded",
                    alreadyCleared: issue.clearedAt !== null,
                    alreadyResolved: !requested,
                };
            }
            return { kind: "lost-race" };
        });

        switch (outcome.kind) {
            case "missing": missing = true; break;
            case "reused": reused = true; break;
            case "never-requested": neverRequested = true; break;
            case "mismatch": mismatch = true; break;
            case "recorded":
                recorded = { targetKey: bankLineId };
                alreadyCleared = outcome.alreadyCleared;
                alreadyResolved = outcome.alreadyResolved;
                break;
            case "lost-race":
                // Loop again for a fresh read — still under a fresh lock.
                break;
        }
    }

    if (missing) {
        return NextResponse.json({ ok: true, ignored: true, reason: "unknown-target" });
    }
    if (reused) {
        return NextResponse.json(
            {
                ok: false,
                reason: "artifact-reused",
                detail: "this Drive file is already recorded as memo-signed evidence on a different charge",
                targetKey: bankLineId,
            },
            { status: 409 },
        );
    }
    if (neverRequested) {
        return NextResponse.json(
            {
                ok: false,
                reason: "not-requested",
                detail: "no chase card has ever asked about this charge",
                targetKey: bankLineId,
            },
            { status: 422 },
        );
    }
    if (mismatch) {
        return NextResponse.json(
            {
                ok: false,
                reason: "artifact-mismatch",
                detail: "the PDF's name does not match this charge",
                targetKey: bankLineId,
            },
            { status: 422 },
        );
    }
    if (!recorded) {
        // Two attempts both lost the race. Clearing now would silence the chase
        // with nothing on the row to say why, and the next sweep would reopen
        // it anyway. 409 so the forwarder retries — the record is idempotent.
        return NextResponse.json(
            { ok: false, reason: "resolution-not-recorded", targetKey: bankLineId },
            { status: 409 },
        );
    }

    // The issue was already closed by the matcher; the memo is now recorded on
    // it, which is the whole point — a later reopen is suppressed. Nothing to
    // clear.
    //
    // `alreadyResolved` distinguishes the card-history race: the issue carried
    // no record of ever having been asked, and it was already answered, so this
    // signature is a valid late reply to a chase that has closed. A 200 with
    // that flag, never a 422 — the forwarder must be able to retry it and get
    // the same answer.
    if (alreadyCleared) {
        return NextResponse.json({
            ok: true,
            alreadyCleared: true,
            ...(alreadyResolved ? { alreadyResolved: true } : {}),
            memoRecorded: true,
            targetKey: bankLineId,
        });
    }

    // Empty codes = lifecycle step 1 = clear, and it cancels any open episode.
    // Reached only because the resolution is durably on the row, so a sweep
    // that races this clear still sees the resolution and will not reopen.
    await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, bankLineId, [], null);

    return NextResponse.json({ ok: true, cleared: true, memoRecorded: true, targetKey: bankLineId });
}
