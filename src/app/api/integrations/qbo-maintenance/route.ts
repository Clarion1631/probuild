import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getFreshQBTokens, QBNotConnectedError, sweepPendingPayLinks, automationSettingCursorStore } from "@/lib/quickbooks-payments";
import {
    createRouteDeadline,
    isBudgetExhausted,
    isQBBudgetExhaustedError,
    isQboConnectionFailure,
    isQboReconnectRequired,
    isQBTimeoutError,
} from "@/lib/quickbooks";
import { QBO_AUTH_EVENT_REASON } from "@/lib/pipeline-health";
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
 *     Then finishes any row left `paylink-pending` by a pay-link timeout, on
 *     both the milestone and the progress-billing rail.
 *
 *     `ok` describes the RUN, not the fact that the handler returned. A row
 *     whose LINKED invoice is no longer in QuickBooks counts as outstanding
 *     work (`missingInQbo` + `missingInQboRows`, reason `qbo-invoice-missing`)
 *     — it is a bill the client can no longer pay, so it must not be reported
 *     inside a clean pass.
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
            // deleteQBPayment now throws (rather than returning false) on a
            // shared QBO failure (401/403/429/5xx) so a caller looping over
            // rows can tell it apart from a per-document refusal — this single
            // caller has no loop to protect, so it just reports the failure.
            try {
                const deleted = await deleteQBPayment(qbTokens, body.qbPaymentId, deadline);
                return NextResponse.json({ ok: deleted });
            } catch (e) {
                return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message.slice(0, 300) : "delete failed" }, { status: 500 });
            }
        }
        if (body.action === "delete-qbo-invoice") {
            if (!body.qbInvoiceId) return NextResponse.json({ ok: false, reason: "qbInvoiceId required" }, { status: 400 });
            try {
                const deleted = await deleteQBInvoice(qbTokens, body.qbInvoiceId, deadline);
                return NextResponse.json({ ok: deleted });
            } catch (e) {
                return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message.slice(0, 300) : "delete failed" }, { status: 500 });
            }
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

    // Paged by id with a cursor rather than one `take: 200` slice. A fixed take
    // silently ignored everything past the 200th row: the response said
    // "checked 200, ok" and the 201st unpaid invoice was never looked at, run
    // after run. Now the sweep walks the whole set, and when it cannot finish
    // it SAYS so (`truncated`) and reports how many are left.
    const SWEEP_PAGE_SIZE = 100;
    const scheduleWhere = { qbInvoiceId: { not: null }, status: { not: "Paid" } } as const;

    // Where this sweep resumes from, run to run. Same idea and store as the
    // payments/pay-link sweeps' resume cursors (quickbooks-payments.ts): the
    // cursor used to be re-seeded to `null` on every invocation, so a budget
    // cutoff or an outage always re-walked the SAME leading rows on retry and
    // anything past the cap was never reached — a starved tail, forever.
    const SWEEP_CURSOR_KEY = "qbo-maintenance.sync-payment-options.cursor";

    const results: { qbInvoiceId: string; code: string; result: string }[] = [];
    // Same rule as the payments loop: a shared connection failure means every
    // remaining row fails identically at full cost, so stop and report what was
    // done instead of burning the ceiling proving it 200 times over.
    let abortedReason: string | null = null;
    // "" is how "start from the top" is stored; it is never a real id.
    const storedCursor = await automationSettingCursorStore.get(SWEEP_CURSOR_KEY);
    let cursor: string | null = storedCursor && storedCursor.length > 0 ? storedCursor : null;
    let lastCompletedId: string | null = null;

    pager: while (!abortedReason) {
        const page: Array<{ id: string; qbInvoiceId: string | null; name: string; invoice: { code: string } }> =
            await prisma.paymentSchedule.findMany({
                where: scheduleWhere,
                select: { id: true, qbInvoiceId: true, name: true, invoice: { select: { code: true } } },
                orderBy: { id: "asc" },
                take: SWEEP_PAGE_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
        if (page.length === 0) break;
        cursor = page[page.length - 1].id;

        for (const s of page) {
            if (isBudgetExhausted(deadline)) {
                abortedReason = "budget-exhausted";
                break pager;
            }
            const qbId = s.qbInvoiceId!;
            try {
                const current = await getQBInvoicePaymentOptions(tokens, qbId, deadline);
                if (!current) {
                    results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: "not-found-in-qbo" });
                    lastCompletedId = s.id;
                    continue;
                }
                if (current.card && current.ach) {
                    results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: "already-correct" });
                    lastCompletedId = s.id;
                    continue;
                }
                const updated = await setQBInvoicePaymentOptions(tokens, qbId, current.syncToken, { card: true, ach: true }, deadline);
                results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: updated ? "updated" : "update-failed" });
                lastCompletedId = s.id;
            } catch (e) {
                if (isQBBudgetExhaustedError(e)) {
                    abortedReason = "budget-exhausted";
                    break pager;
                }
                if (isQboConnectionFailure(e)) {
                    // 401/403 is the credential, not an outage — reported under
                    // the reconnect reason the health digest counts, same rule
                    // as the payments sweep and its preflight.
                    abortedReason = isQboReconnectRequired(e)
                        ? QBO_AUTH_EVENT_REASON
                        : isQBTimeoutError(e) ? "qbo-timeout" : "qbo-unavailable";
                    break pager;
                }
                results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: `error: ${e instanceof Error ? e.message.slice(0, 120) : "?"}` });
                // A per-row business failure is finished as far as the cursor is
                // concerned — the next run must not retry the same bad row forever.
                lastCompletedId = s.id;
            }
        }
        if (page.length < SWEEP_PAGE_SIZE) break;
    }

    // Persist where to resume. A run that stopped early (budget or a shared
    // outage) resumes from the last row it actually finished, so the NEXT
    // invocation continues into the tail instead of re-checking the same
    // leading rows again. A run that walked the whole collection resets to the
    // top ("") so the window rolls over the whole set rather than resuming
    // from the end forever. Never throws — a lost cursor costs one restart
    // from the top, never correctness (see automationSettingCursorStore).
    await automationSettingCursorStore.set(SWEEP_CURSOR_KEY, abortedReason ? (lastCompletedId ?? "") : "");

    // How many rows this run never reached. Counted from the database rather
    // than inferred from the page, so it includes everything past the cursor.
    let remaining = 0;
    if (abortedReason) {
        remaining = await prisma.paymentSchedule.count({
            where: lastCompletedId ? { ...scheduleWhere, id: { gt: lastCompletedId } } : scheduleWhere,
        }).catch(() => -1);
    }
    // Any row that actually failed, as opposed to being already correct.
    const failedRows = results.filter((r) => r.result.startsWith("error:") || r.result === "update-failed").length;

    // Rows whose LINKED QuickBooks invoice is not there any more.
    //
    // This used to be excluded from `failedRows` on the reading that a 404 is
    // "a finding, not a failure" — the row was recorded and the sweep still
    // returned ok:true. But a linked invoice that has vanished is not a neutral
    // observation about QuickBooks: it is a bill the client can no longer pay,
    // sitting on a row ProBuild still believes is outstanding, and nobody was
    // told because the run read as a clean pass. It is outstanding work, so it
    // makes the sweep ok:false and it is named — count plus row ids — where
    // pipeline health can see it.
    const missingRows = results.filter((r) => r.result === "not-found-in-qbo");
    const missingInQbo = missingRows.length;

    // Same pass, second repair: rows whose invoice IS linked but whose pay-link
    // fetch timed out (marked `paylink-pending` by the milestone push / progress
    // billing stage). Skipped when the options loop already hit the wall — the
    // connection is shared, so there is nothing left to try.
    let payLinks: Awaited<ReturnType<typeof sweepPendingPayLinks>> | null = null;
    if (!abortedReason) {
        payLinks = await sweepPendingPayLinks(tokens, deadline);
        if (payLinks.reason) abortedReason = payLinks.reason;
    }

    // Work left undone, by any route: the options loop stopped early, the
    // pay-link sweep hit its per-rail cap, or rows were skipped inside it.
    const truncated = abortedReason !== null || !!payLinks?.truncated || (payLinks?.skipped ?? 0) > 0;

    // `ok` reflects the RUN, not the fact that the handler returned. A run that
    // stopped early, left rows unvisited, or failed on a row has work
    // outstanding and must not read as a clean pass — that reading is what let
    // a 200-row cap look like a complete sweep for as long as it did.
    const ok = !truncated && failedRows === 0 && missingInQbo === 0;
    return NextResponse.json({
        ok,
        checked: results.length,
        failed: failedRows,
        ...(missingInQbo > 0
            ? {
                missingInQbo,
                // The ids, not just the count: "3 invoices vanished" is not
                // actionable, "these three" is.
                missingInQboRows: missingRows.map((r) => ({ qbInvoiceId: r.qbInvoiceId, code: r.code })),
            }
            : {}),
        ...(truncated ? { truncated: true, retry: true } : {}),
        ...(abortedReason ? { reason: abortedReason, remaining } : {}),
        ...(!abortedReason && failedRows > 0 ? { reason: "row-errors" } : {}),
        // A missing invoice is reported under its own reason so the health
        // digest can tell it apart from a row that merely errored. Only when
        // nothing louder already claimed `reason`.
        ...(!abortedReason && failedRows === 0 && missingInQbo > 0 ? { reason: "qbo-invoice-missing" } : {}),
        ...(payLinks ? { payLinks } : {}),
        results,
    });
}
