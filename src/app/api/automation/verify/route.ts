import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { qbQuery, escapeQBString } from "@/lib/quickbooks";
import { resolveEventFileId } from "@/lib/automation-events";
import { readIdentifier, resolveReceiptPushEvent, trustedQbPurchaseId } from "@/lib/automation-key-resolver";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const TAX_ACCOUNT_ID_DEFAULT = "1150040032";

/**
 * Command Center "Verify now": an audit event proves a booking was ATTEMPTED
 * or succeeded at that moment — it does not prove QuickBooks still holds the
 * correct record. This endpoint re-reads the Purchase from QBO on demand and
 * returns booking-time evidence next to the live state, with cent-exact
 * verdicts computed server-side. Read-only against QBO.
 */
interface QboPurchaseRow {
    Id: string;
    TotalAmt?: number;
    TxnDate?: string;
    DocNumber?: string;
    PrivateNote?: string;
    EntityRef?: { name?: string };
    Line?: Array<{
        Amount?: number;
        DetailType?: string;
        AccountBasedExpenseLineDetail?: {
            AccountRef?: { value?: string };
            CustomerRef?: { name?: string };
        };
    }>;
}

export async function POST(request: Request) {
    const user = await getCurrentUserWithPermissions();
    if (!user) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    if (!hasPermission(user, "financialReports")) {
        return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
    }

    let parsed: unknown;
    try {
        parsed = await request.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (typeof parsed !== "object" || parsed === null) {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    const body = parsed as { docNumber?: unknown; driveFileId?: unknown; qbPurchaseId?: unknown };
    const docNumber = readIdentifier(body.docNumber, 30);
    const driveFileId = readIdentifier(body.driveFileId, 128);
    const qbPurchaseIdInput = readIdentifier(body.qbPurchaseId, 64);
    if (!docNumber && !driveFileId && !qbPurchaseIdInput) {
        return NextResponse.json({ ok: false, reason: "invalid-doc-number" }, { status: 400 });
    }

    // Booking-time evidence: the ORIGINAL "created" event. A later retry
    // returns "already-exists" carrying the RETRY's extraction values —
    // comparing live QBO against those would report false mismatches and a
    // wrong bookedAt. Fall back to already-exists only when the created
    // record was never captured (pre-logging history).
    //
    // Resolve via the FULL driveFileId/qbPurchaseId first (near-zero
    // collision risk); the bare docNumber (fileId.slice(0,21) —
    // qbo-receipt-push.ts:477-481) is a LEGACY FALLBACK only, since two
    // different Drive fileIds can share that prefix. That fallback refuses
    // to guess when the prefix genuinely matches more than one receipt.
    const resolution = await resolveReceiptPushEvent({ docNumber, driveFileId, qbPurchaseId: qbPurchaseIdInput });
    if (resolution.outcome === "ambiguous") {
        return NextResponse.json(
            { ok: false, reason: "ambiguous-match", candidateCount: resolution.candidateCount },
            { status: 409 },
        );
    }
    if (resolution.outcome === "not-found") {
        return NextResponse.json({ ok: false, reason: "no-booking-on-record" }, { status: 404 });
    }
    const pushEvent = resolution.event;
    // False when this match came from the bare-prefix legacy fallback — the
    // caller must not present the verify result as tied to a confirmed
    // receipt.
    const matchConfirmed = resolution.confirmed;
    const expectedFileId = resolution.fullFileId ?? resolveEventFileId(pushEvent);
    // Derived ONLY from the resolved event — NEVER the raw `qbPurchaseIdInput`
    // above. A client can send a `driveFileId` that resolves event A and a
    // conflicting `qbPurchaseId` naming event B; querying QBO with B's id
    // would compare A's booking evidence against B's live purchase while the
    // response calls it confirmed. `resolveReceiptPushEvent`'s own tiers
    // already resolve exactly this value when the match came from the
    // qbPurchaseId tier, so nothing is lost by ignoring the raw client input.
    const qbPurchaseId = trustedQbPurchaseId(pushEvent);
    if (!qbPurchaseId) {
        return NextResponse.json({ ok: false, reason: "no-purchase-id-on-record" }, { status: 404 });
    }

    try {
        const tokens = await getFreshQBTokens();
        const rows = await qbQuery<QboPurchaseRow>(tokens, `SELECT * FROM Purchase WHERE Id = '${escapeQBString(qbPurchaseId)}'`);
        const verifiedAt = new Date().toISOString();

        if (rows.length === 0) {
            return NextResponse.json({
                ok: true,
                verifiedAt,
                deleted: true,
                booking: bookingEvidence(pushEvent),
                live: null,
                verdicts: [{ field: "existence", state: "needs-attention", note: "Purchase no longer exists in QuickBooks (deleted or voided)." }],
                // False when this booking evidence came from the bare-prefix
                // legacy fallback — never present it as a confirmed match.
                unconfirmedMatch: !matchConfirmed,
            });
        }

        const p = rows[0];
        const taxAccountId = process.env.QBO_RECEIPT_TAX_ACCOUNT_ID || TAX_ACCOUNT_ID_DEFAULT;
        const expenseLines = (p.Line ?? []).filter(l => l?.DetailType === "AccountBasedExpenseLineDetail");
        const liveTaxCents = expenseLines
            .filter(l => String(l.AccountBasedExpenseLineDetail?.AccountRef?.value) === taxAccountId)
            .reduce((sum, l) => sum + Math.round(Number(l.Amount || 0) * 100), 0);
        // ALL job-coded lines, not just the first — a purchase with one line
        // still on the right project and another reassigned must not verify.
        const liveProjects = [...new Set(
            expenseLines
                .map(l => l.AccountBasedExpenseLineDetail?.CustomerRef?.name)
                .filter((n): n is string => Boolean(n)),
        )];
        const liveProject = liveProjects.length === 1 ? liveProjects[0]
            : liveProjects.length > 1 ? liveProjects.join(" + ")
            : null;
        const live = {
            amountCents: Number.isFinite(Number(p.TotalAmt)) ? Math.round(Number(p.TotalAmt) * 100) : null,
            taxCents: liveTaxCents,
            vendor: p.EntityRef?.name ?? null,
            projectName: liveProject,
            txnDate: p.TxnDate ?? null,
            markerIntact: expectedFileId ? (p.PrivateNote ?? "").includes(`[gtr-file:${expectedFileId}]`) : null,
        };

        // Cent-exact verdicts for money; softer note for vendor (aliases and
        // capitalization are normal); project compared by exact name (QBO
        // customer names ARE the project identity in this pipeline).
        const verdicts: Array<{ field: string; state: "verified" | "needs-attention" | "unknown"; note?: string }> = [];
        const cmpCents = (field: string, expected: number | null, actual: number | null) => {
            if (expected == null || actual == null) verdicts.push({ field, state: "unknown" });
            else if (expected === actual) verdicts.push({ field, state: "verified" });
            else verdicts.push({ field, state: "needs-attention", note: `differs by $${(Math.abs(expected - actual) / 100).toFixed(2)}` });
        };
        cmpCents("amount", pushEvent.amountCents, live.amountCents);
        cmpCents("tax", pushEvent.taxCents ?? 0, live.taxCents);
        if (pushEvent.projectName && liveProjects.length > 0) {
            const expected = pushEvent.projectName.trim().toLowerCase();
            const allMatch = liveProjects.length === 1 && liveProjects[0].trim().toLowerCase() === expected;
            verdicts.push(allMatch
                ? { field: "project", state: "verified" }
                : { field: "project", state: "needs-attention", note: `lines coded to "${liveProjects.join('", "')}", expected "${pushEvent.projectName}"` });
        } else {
            verdicts.push({ field: "project", state: "unknown" });
        }
        if (pushEvent.vendor && live.vendor) {
            verdicts.push(pushEvent.vendor.trim().toLowerCase() === live.vendor.trim().toLowerCase()
                ? { field: "vendor", state: "verified" }
                : { field: "vendor", state: "needs-attention", note: `QBO shows "${live.vendor}" (aliases are common — check, don't panic)` });
        } else {
            verdicts.push({ field: "vendor", state: "unknown" });
        }
        if (live.markerIntact === false) {
            verdicts.push({ field: "marker", state: "needs-attention", note: "The idempotency marker was edited out of the memo — duplicate protection for this file is weakened." });
        }

        return NextResponse.json({
            ok: true,
            verifiedAt,
            deleted: false,
            booking: bookingEvidence(pushEvent),
            live,
            verdicts,
            // False when this booking evidence came from the bare-prefix
            // legacy fallback — never present it as a confirmed match.
            unconfirmedMatch: !matchConfirmed,
        });
    } catch (error) {
        if (error instanceof QBNotConnectedError) {
            return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
        }
        console.error("verify-now failed", error instanceof Error ? error.name : "UnknownError");
        return NextResponse.json({ ok: false, reason: "verify-failed" }, { status: 500 });
    }
}

function bookingEvidence(event: { amountCents: number | null; taxCents: number | null; vendor: string | null; projectName: string | null; createdAt: Date; detail: string | null }) {
    let attachment: string | null = null;
    try {
        const d = JSON.parse(event.detail ?? "{}") as { attachment?: unknown };
        if (typeof d.attachment === "string") attachment = d.attachment;
    } catch { /* display data */ }
    return {
        amountCents: event.amountCents,
        taxCents: event.taxCents,
        vendor: event.vendor,
        projectName: event.projectName,
        bookedAt: event.createdAt,
        attachment,
    };
}
