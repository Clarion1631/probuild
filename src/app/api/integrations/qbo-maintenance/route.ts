import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import {
    createRouteDeadline,
    isBudgetExhausted,
    isQBBudgetExhaustedError,
    isQboConnectionFailure,
    isQBTimeoutError,
} from "@/lib/quickbooks";
import {
    getQBInvoicePaymentOptions, setQBInvoicePaymentOptions,
    createQBPaymentForInvoice, deleteQBPayment, deleteQBInvoice,
} from "@/lib/quickbooks";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Idempotent QBO maintenance, secret-gated like the other /api/integrations
 * routes. Currently one action:
 *
 *   POST { "action": "sync-payment-options" }
 *     Ensures every UNPAID milestone's QBO invoice accepts card + bank transfer
 *     (the canonical setting). Repairs invoices pushed under older toggles —
 *     e.g. the brief bank-only window on 6/11 — without touching paid ones.
 */
export async function POST(req: Request) {
    // One budget for the whole request, whichever action it turns out to be.
    const deadline = createRouteDeadline(100_000);
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    let body: { action?: string; paymentScheduleId?: string; qbInvoiceId?: string; qbPaymentId?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }

    // ── Settle-loop QA + test cleanup actions (all idempotent, secret-gated) ──
    if (body.action === "test-settle" || body.action === "delete-qbo-payment" || body.action === "delete-qbo-invoice" || body.action === "sync-payments" || body.action === "test-team-notify") {
        // sync-payments does its OWN token refresh inside
        // syncQuickBooksPayments, so refreshing here just spent a QBO round
        // trip on a value that was then discarded. Skip it for that action.
        let tokens: Awaited<ReturnType<typeof getFreshQBTokens>> | undefined;
        if (body.action !== "sync-payments") {
            try {
                tokens = await getFreshQBTokens(deadline);
            } catch (e) {
                if (e instanceof QBNotConnectedError) {
                    return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
                }
                if (isQBBudgetExhaustedError(e)) {
                    return NextResponse.json({ ok: false, reason: "qbo-budget-exhausted", retry: true }, { status: 503 });
                }
                throw e;
            }
        }

        // sync-payments never needed the refresh above and returns here; every
        // branch past this point ran it, so `tokens` is defined.
        if (body.action === "sync-payments") {
            const { syncQuickBooksPayments } = await import("@/lib/quickbooks-payments");
            const result = await syncQuickBooksPayments(undefined, { source: "manual", deadline });
            // `ok` reflects the RUN, not the fact that the handler returned. A
            // run that failed outright, skipped rows, or hit row errors left
            // work undone, and reporting ok:true taught every caller (and the
            // operator reading it) that the sweep was clean. Status stays 200:
            // the request itself succeeded and the body carries the detail.
            const incomplete = result.runFailed || result.skipped > 0 || result.errors.length > 0;
            return NextResponse.json({
                ok: !incomplete,
                ...(incomplete
                    ? { reason: result.failureReason ?? "incomplete-run", retry: true }
                    : {}),
                ...result,
            });
        }
        const qbTokens = tokens!;
        if (body.action === "test-settle") {
            if (!body.qbInvoiceId) return NextResponse.json({ ok: false, reason: "qbInvoiceId required" }, { status: 400 });
            const created = await createQBPaymentForInvoice(qbTokens, body.qbInvoiceId, deadline);
            if (!created) return NextResponse.json({ ok: false, reason: "invoice-not-found-or-already-paid" });
            return NextResponse.json({ ok: true, ...created });
        }
        if (body.action === "test-team-notify") {
            if (!body.paymentScheduleId) return NextResponse.json({ ok: false, reason: "paymentScheduleId required" }, { status: 400 });
            const { notifyMilestonePaid } = await import("@/lib/payment-notifications");
            const sent = await notifyMilestonePaid(body.paymentScheduleId);
            return NextResponse.json({ ok: true, sent: sent ?? null });
        }
        if (body.action === "delete-qbo-payment") {
            if (!body.qbPaymentId) return NextResponse.json({ ok: false, reason: "qbPaymentId required" }, { status: 400 });
            const deleted = await deleteQBPayment(qbTokens, body.qbPaymentId, deadline);
            return NextResponse.json({ ok: deleted });
        }
        if (body.action === "delete-qbo-invoice") {
            if (!body.qbInvoiceId) return NextResponse.json({ ok: false, reason: "qbInvoiceId required" }, { status: 400 });
            const deleted = await deleteQBInvoice(qbTokens, body.qbInvoiceId, deadline);
            return NextResponse.json({ ok: deleted });
        }
    }

    // Push (or re-fetch) one milestone's QBO invoice — same path signing uses.
    if (body.action === "push-milestone") {
        if (!body.paymentScheduleId) {
            return NextResponse.json({ ok: false, reason: "paymentScheduleId required" }, { status: 400 });
        }
        const { pushMilestoneToQuickBooks } = await import("@/lib/quickbooks-payments");
        try {
            const res = await pushMilestoneToQuickBooks(body.paymentScheduleId, undefined, deadline);
            return NextResponse.json({ ok: true, ...res });
        } catch (e) {
            return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message.slice(0, 300) : "push failed" }, { status: 500 });
        }
    }

    if (body.action !== "sync-payment-options") {
        return NextResponse.json({ ok: false, reason: "unknown-action" }, { status: 400 });
    }

    let tokens;
    try {
        tokens = await getFreshQBTokens(deadline);
    } catch (e) {
        if (e instanceof QBNotConnectedError) {
            return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
        }
        if (isQBBudgetExhaustedError(e)) {
            return NextResponse.json({ ok: false, reason: "qbo-budget-exhausted", retry: true }, { status: 503 });
        }
        throw e;
    }

    const schedules = await prisma.paymentSchedule.findMany({
        where: { qbInvoiceId: { not: null }, status: { not: "Paid" } },
        select: { id: true, qbInvoiceId: true, name: true, invoice: { select: { code: true } } },
        take: 200,
    });

    const results: { qbInvoiceId: string; code: string; result: string }[] = [];
    // Same rule as the payments loop: a shared connection failure means every
    // remaining row fails identically at full cost, so stop and report what was
    // done instead of burning the ceiling proving it 200 times over.
    let skipped = 0;
    let abortedReason: string | null = null;
    for (const [index, s] of schedules.entries()) {
        if (abortedReason) {
            skipped = schedules.length - index;
            break;
        }
        if (isBudgetExhausted(deadline)) {
            abortedReason = "budget-exhausted";
            skipped = schedules.length - index;
            break;
        }
        const qbId = s.qbInvoiceId!;
        try {
            const current = await getQBInvoicePaymentOptions(tokens, qbId, deadline);
            if (!current) {
                results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: "not-found-in-qbo" });
                continue;
            }
            if (current.card && current.ach) {
                results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: "already-correct" });
                continue;
            }
            const updated = await setQBInvoicePaymentOptions(tokens, qbId, current.syncToken, { card: true, ach: true }, deadline);
            results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: updated ? "updated" : "update-failed" });
        } catch (e) {
            if (isQBBudgetExhaustedError(e)) {
                abortedReason = "budget-exhausted";
                skipped = schedules.length - index;
                break;
            }
            if (isQboConnectionFailure(e)) {
                abortedReason = isQBTimeoutError(e) ? "qbo-timeout" : "qbo-unavailable";
                skipped = schedules.length - index - 1;
                break;
            }
            results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: `error: ${e instanceof Error ? e.message.slice(0, 120) : "?"}` });
        }
    }

    // `ok` reflects whether the sweep actually finished: a run that stopped
    // early has left work undone and must not read as a clean pass.
    return NextResponse.json({
        ok: abortedReason === null,
        checked: results.length,
        skipped,
        ...(abortedReason ? { reason: abortedReason, retry: true } : {}),
        results,
    });
}
