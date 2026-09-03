import { NextResponse } from "next/server";
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
import { centsToAmount } from "@/lib/receipt-request-cards";
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
 * is the DOLLAR AMOUNT: a fixed "123.45" string the generator embeds verbatim,
 * specific enough that a PDF minted for a different charge will not carry it.
 */
const AFFIDAVIT_NAME_PREFIX = "MissingReceiptAffidavit_";

/**
 * True when a probed Drive filename could plausibly BE the signed memo for
 * THIS charge, rather than some other PDF the bridge secret happens to be
 * able to read.
 *
 * `signed:true` plus a Drive id that merely EXISTS used to be enough to close
 * a chase — nothing tied the artifact to the charge it claims to answer
 * (Codex PR #443 gate, finding 3). Not exact-format verification — Beverly's
 * vendor/date sanitization is not this route's to pin down — but a PDF minted
 * for a different amount will not contain this issue's own "123.45", and a
 * file with the wrong prefix was never produced by the sign flow at all.
 */
function affidavitNameMatchesIssue(name: string | null, amountCents: number): boolean {
    if (!name) return false;
    if (!name.toLowerCase().endsWith(".pdf")) return false;
    if (!name.startsWith(AFFIDAVIT_NAME_PREFIX)) return false;
    return name.includes(centsToAmount(amountCents));
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
 */
async function pdfIdReusedElsewhere(pdfId: string, ownTargetKey: string): Promise<boolean> {
    const candidates = await prisma.reviewIssue.findMany({
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
    let missing = false;
    let neverRequested = false;
    let mismatch = false;
    let reused = false;

    for (let attempt = 0; attempt < 2 && !recorded && !alreadyCleared && !missing && !neverRequested && !mismatch && !reused; attempt++) {
        const issue = await prisma.reviewIssue.findUnique({
            where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: bankLineId } },
            select: { id: true, version: true, displayDetails: true, clearedAt: true },
        });
        if (!issue) { missing = true; break; }

        // THE ARTIFACT MUST BE BOUND TO THIS CHARGE, not merely accessible.
        // A caller-supplied fingerprint plus any readable Drive PDF used to be
        // enough to close a chase: nothing checked that this item was ever
        // actually asked about, that the file was minted FOR it, or that the
        // SAME file was not already spent answering a different one (Codex
        // PR #443 gate, finding 3). Checked on the FIRST attempt only — a
        // fresh read on a lost race would repeat identically.
        if (attempt === 0 && await pdfIdReusedElsewhere(pdfId, bankLineId)) { reused = true; break; }

        // Merged from THIS read, not from anything older: a card record or a
        // corrected amount written since must survive.
        const details = parseMissingReceiptDetails(issue.displayDetails);

        if (!hasRecordedMemoRequest(details)) { neverRequested = true; break; }
        const amountCents = typeof details.amountCents === "number" ? details.amountCents : null;
        if (amountCents === null || !affidavitNameMatchesIssue(probe.name, amountCents)) {
            mismatch = true;
            break;
        }

        details.resolution = "memo-signed";
        // The ID is the durable identity; the URL is how a human opens it.
        details.pdfId = pdfId;
        if (artifactUrl) details.pdfUrl = artifactUrl;
        if (typeof body.at === "string") details.signedAt = body.at.slice(0, 64);
        if (typeof body.thread === "string") details.signedThread = body.thread.slice(0, 200);

        // RECORDED EVEN ON A CLEARED ISSUE (Codex round-4 item 3).
        //
        // A memo signed after the nightly matcher had already auto-closed the
        // line used to be discarded — so when the matching receipt was later
        // deleted, the sweep reopened a charge somebody had genuinely answered
        // weeks earlier. A valid signature is evidence whatever the issue's
        // current state, and `resolution` is exactly the field the matcher
        // reads to suppress a reopen.
        const written = await prisma.reviewIssue.updateMany({
            where: { id: issue.id, version: issue.version },
            data: { displayDetails: JSON.stringify(details), version: { increment: 1 } },
        });
        if (written.count === 1) {
            recorded = { targetKey: bankLineId };
            alreadyCleared = issue.clearedAt !== null;
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
    if (alreadyCleared) {
        return NextResponse.json({ ok: true, alreadyCleared: true, memoRecorded: true, targetKey: bankLineId });
    }

    // Empty codes = lifecycle step 1 = clear, and it cancels any open episode.
    // Reached only because the resolution is durably on the row, so a sweep
    // that races this clear still sees the resolution and will not reopen.
    await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, bankLineId, [], null);

    return NextResponse.json({ ok: true, cleared: true, memoRecorded: true, targetKey: bankLineId });
}
