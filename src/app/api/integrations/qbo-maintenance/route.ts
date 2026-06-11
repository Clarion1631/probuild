import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import { getQBInvoicePaymentOptions, setQBInvoicePaymentOptions } from "@/lib/quickbooks";

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
    const secret = process.env.RECEIPT_INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-key") !== secret) {
        return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }

    let body: { action?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (body.action !== "sync-payment-options") {
        return NextResponse.json({ ok: false, reason: "unknown-action" }, { status: 400 });
    }

    let tokens;
    try {
        tokens = await getFreshQBTokens();
    } catch (e) {
        if (e instanceof QBNotConnectedError) {
            return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
        }
        throw e;
    }

    const schedules = await prisma.paymentSchedule.findMany({
        where: { qbInvoiceId: { not: null }, status: { not: "Paid" } },
        select: { id: true, qbInvoiceId: true, name: true, invoice: { select: { code: true } } },
        take: 200,
    });

    const results: { qbInvoiceId: string; code: string; result: string }[] = [];
    for (const s of schedules) {
        const qbId = s.qbInvoiceId!;
        try {
            const current = await getQBInvoicePaymentOptions(tokens, qbId);
            if (!current) {
                results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: "not-found-in-qbo" });
                continue;
            }
            if (current.card && current.ach) {
                results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: "already-correct" });
                continue;
            }
            const updated = await setQBInvoicePaymentOptions(tokens, qbId, current.syncToken, { card: true, ach: true });
            results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: updated ? "updated" : "update-failed" });
        } catch (e) {
            results.push({ qbInvoiceId: qbId, code: s.invoice.code, result: `error: ${e instanceof Error ? e.message.slice(0, 120) : "?"}` });
        }
    }

    return NextResponse.json({ ok: true, checked: results.length, results });
}
