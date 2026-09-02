import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { RECEIPT_INTAKE_SECRET_HEADER, secretMatches } from "@/lib/receipt-intake/intake-auth";
import { evaluateReviewIssue } from "@/lib/review-alert-lifecycle";
import { RECEIPT_REQUEST_TARGET_TYPE, bankLineIdFromFingerprint } from "@/lib/receipt-requests";
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
 * NEVER emails anything, and never touches the PDF: it records the link
 * Beverly's app already produced.
 *
 * AUTH: the Phase 1 machine secret, fail-closed. Exact-match proxy bypass, so
 * the caller gets a clean 401 rather than a redirect. No session branch exists.
 */

const MAX_URL_LEN = 2_000;

interface AnswerBody {
    fingerprint?: unknown;
    signed?: unknown;
    pdf_url?: unknown;
    job?: unknown;
    at?: unknown;
    message?: unknown;
    thread?: unknown;
}

function isHttpsUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "https:";
    } catch {
        return false;
    }
}

export async function POST(request: Request) {
    const provided = request.headers.get(RECEIPT_INTAKE_SECRET_HEADER);
    if (!secretMatches(provided, process.env.RECEIPT_INTAKE_SECRET)) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

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

    const issue = await prisma.reviewIssue.findUnique({
        where: { targetType_targetKey: { targetType: RECEIPT_REQUEST_TARGET_TYPE, targetKey: bankLineId } },
        select: { id: true, version: true, displayDetails: true, clearedAt: true },
    });
    if (!issue) {
        return NextResponse.json({ ok: true, ignored: true, reason: "unknown-target" });
    }
    if (issue.clearedAt !== null) {
        // Already answered — a replayed record is a no-op, never a reopen.
        return NextResponse.json({ ok: true, alreadyCleared: true });
    }

    const details = parseMissingReceiptDetails(issue.displayDetails);
    details.resolution = "memo-signed";
    if (typeof body.pdf_url === "string" && body.pdf_url.length <= MAX_URL_LEN && isHttpsUrl(body.pdf_url)) {
        details.pdfUrl = body.pdf_url;
    }
    if (typeof body.at === "string") details.signedAt = body.at.slice(0, 64);
    if (typeof body.thread === "string") details.signedThread = body.thread.slice(0, 200);

    // TWO writes, in this order and for a reason: the lifecycle's "clear" step
    // deliberately does NOT touch displayDetails (episode snapshots stay
    // immutable), so recording the memo has to happen first, version-guarded.
    // If that guard loses a race the clear still runs — silencing a chase whose
    // memo is signed matters more than the link to the PDF, and the answer is
    // honest about which parts landed.
    const recorded = await prisma.reviewIssue.updateMany({
        where: { id: issue.id, version: issue.version, clearedAt: null },
        data: { displayDetails: JSON.stringify(details), version: { increment: 1 } },
    });

    // Empty codes = lifecycle step 1 = clear, and it cancels any open episode.
    await evaluateReviewIssue(RECEIPT_REQUEST_TARGET_TYPE, bankLineId, [], null);

    return NextResponse.json({ ok: true, cleared: true, memoRecorded: recorded.count === 1, targetKey: bankLineId });
}
