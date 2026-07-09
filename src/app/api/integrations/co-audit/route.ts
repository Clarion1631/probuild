import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { coTaxRate, coTaxLabel, coItemsSubtotal } from "@/lib/co-tax";

// One-off data-repair surface for the pre-2026-07-09 change-order editor bug:
// the editor saved totalAmount tax-INCLUSIVE (item subtotal × (1 + rate)) while
// billing treats totalAmount as the PRE-TAX subtotal and adds tax on top, so
// affected COs double-tax when billed (the CO-00007 incident).
//
//   GET  — audit every ChangeOrder: recompute the item subtotal (same
//          integer-cents math as createChangeOrderDraft), classify the stored
//          totalAmount (ok / tax-inflated / drift / no-items), and cross-check
//          Approved COs against their billed "CO-xxxxx — " milestone.
//   POST — { changeOrderId, expectedTotalAmount, force? }: reset ONE Draft/Sent
//          CO's totalAmount + balanceDue to its item subtotal. The verdict is
//          recomputed in-transaction: only tax-inflated rows are repaired
//          unless force:true (drift rows may carry an intentional edit).
//          Refuses Approved/Declined rows, empty-item rows, rows whose
//          balanceDue has diverged from totalAmount, and stale reads
//          (optimistic lock on the current total). Row-locked like
//          billChangeOrderCore.
//
// Secret-gated machine-to-machine route (same pattern as the sibling
// /api/integrations routes): header x-audit-key must equal CO_AUDIT_SECRET.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: Request): boolean {
    const secret = process.env.CO_AUDIT_SECRET;
    if (!secret) return false;
    const key = req.headers.get("x-audit-key") ?? "";
    // Hash both sides to fixed length so neither content nor secret length
    // leaks through timing (mirrors the /api/mcp gate).
    const a = createHash("sha256").update(key).digest();
    const b = createHash("sha256").update(secret).digest();
    return timingSafeEqual(a, b);
}

// Same cents rounding as billChangeOrderCore — the cross-check must round
// exactly like billing does, not merely close to it.
const rc = (n: number) => Math.round(n * 100) / 100;

// GET's "ok" tolerance and POST's no-op tolerance are the SAME constant so a
// row the audit reports as ok can never be mutated by a follow-up POST.
const OK_TOLERANCE = 0.01;

type Verdict = "ok" | "tax-inflated" | "drift" | "no-items";
function classify(stored: number, subtotal: number, expectedBilled: number, itemCount: number): Verdict {
    if (itemCount === 0) return "no-items";
    if (Math.abs(stored - subtotal) <= OK_TOLERANCE) return "ok";
    if (Math.abs(stored - expectedBilled) <= 0.02) return "tax-inflated";
    return "drift";
}

export async function GET(req: Request) {
    if (!authorized(req)) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

    const cos = await prisma.changeOrder.findMany({
        orderBy: { number: "asc" },
        select: {
            id: true, code: true, title: true, status: true,
            totalAmount: true, balanceDue: true, createdAt: true, updatedAt: true,
            approvedAt: true, sentAt: true,
            project: { select: { id: true, name: true } },
            estimate: { select: { code: true, taxExempt: true, taxRatePercent: true, taxRateName: true } },
            items: { select: { quantity: true, unitCost: true, total: true } },
        },
    });

    // Billed-milestone candidates for the Approved cross-check, one query:
    // billChangeOrderCore links by name prefix "CO-xxxxx — " on the project's
    // invoices, non-Canceled.
    const coMilestones = await prisma.paymentSchedule.findMany({
        where: { name: { startsWith: "CO-" }, status: { not: "Canceled" } },
        select: {
            id: true, name: true, amount: true, status: true,
            invoice: { select: { code: true, projectId: true } },
        },
    });

    const rows = cos.map(co => {
        const stored = rc(Number(co.totalAmount));
        const subtotal = coItemsSubtotal(co.items.map(i => ({ quantity: i.quantity, unitCost: Number(i.unitCost) })));
        const rate = coTaxRate(co.estimate);
        const tax = rc(subtotal * rate);
        const expectedBilled = rc(subtotal + tax); // what billing charges once fixed
        const inflated = rc(stored - subtotal);
        const verdict = classify(stored, subtotal, expectedBilled, co.items.length);

        const milestones = coMilestones
            .filter(m => m.invoice.projectId === co.project.id && m.name.startsWith(`${co.code} — `))
            .map(m => ({
                id: m.id, name: m.name, amount: rc(Number(m.amount)), status: m.status,
                invoiceCode: m.invoice.code,
                matchesExpectedBilled: Math.abs(rc(Number(m.amount)) - expectedBilled) <= 0.01,
            }));

        return {
            changeOrderId: co.id,
            code: co.code,
            title: co.title,
            project: co.project.name,
            status: co.status,
            verdict,
            storedTotalAmount: stored,
            storedBalanceDue: rc(Number(co.balanceDue)),
            itemCount: co.items.length,
            itemSubtotal: subtotal,
            storedLineTotalsSum: rc(co.items.reduce((s, i) => s + Number(i.total), 0)),
            taxTreatment: coTaxLabel(co.estimate),
            taxRate: rate,
            expectedBilledAmount: expectedBilled,
            storedMinusSubtotal: inflated,
            estimateCode: co.estimate?.code ?? null,
            sentAt: co.sentAt, approvedAt: co.approvedAt, updatedAt: co.updatedAt,
            billedMilestones: milestones,
        };
    });

    return NextResponse.json({
        ok: true,
        total: rows.length,
        summary: {
            ok: rows.filter(r => r.verdict === "ok").length,
            taxInflated: rows.filter(r => r.verdict === "tax-inflated").length,
            drift: rows.filter(r => r.verdict === "drift").length,
            noItems: rows.filter(r => r.verdict === "no-items").length,
        },
        changeOrders: rows,
    });
}

export async function POST(req: Request) {
    if (!authorized(req)) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

    let body: { changeOrderId?: string; expectedTotalAmount?: number; force?: boolean };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, reason: "invalid-json" }, { status: 400 });
    }
    if (!body.changeOrderId || typeof body.expectedTotalAmount !== "number") {
        return NextResponse.json({ ok: false, reason: "changeOrderId and expectedTotalAmount required" }, { status: 400 });
    }
    const { changeOrderId, expectedTotalAmount, force } = body;

    const result = await prisma.$transaction(async tx => {
        // Row lock so a concurrent approve/send/bill serializes against the fix.
        const locked = await tx.$queryRaw<Array<{ id: string; code: string; title: string; status: string; totalAmount: unknown; balanceDue: unknown; projectId: string; estimateId: string }>>`
            SELECT "id", "code", "title", "status", "totalAmount", "balanceDue", "projectId", "estimateId"
            FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
        const co = locked[0];
        if (!co) return { ok: false as const, error: "Change order not found" };
        if (co.status !== "Draft" && co.status !== "Sent") {
            return { ok: false as const, error: `${co.code} is "${co.status}" — only Draft/Sent change orders may be auto-corrected. Approved rows need human review (billed milestone).` };
        }
        const stored = rc(Number(co.totalAmount));
        if (Math.abs(stored - expectedTotalAmount) > 0.005) {
            return { ok: false as const, error: `Stale read: ${co.code} totalAmount is now $${stored.toFixed(2)}, not $${expectedTotalAmount.toFixed(2)}. Re-run the audit.` };
        }
        const balance = rc(Number(co.balanceDue));
        if (Math.abs(balance - stored) > 0.005) {
            return { ok: false as const, error: `${co.code} balanceDue ($${balance.toFixed(2)}) has diverged from totalAmount ($${stored.toFixed(2)}) — review by hand before resetting either.` };
        }
        const items = await tx.changeOrderItem.findMany({
            where: { changeOrderId },
            select: { quantity: true, unitCost: true },
        });
        // Re-derive the verdict under the lock — the repair only applies to the
        // tax-inclusive-total bug. A drift row (total matches neither subtotal
        // nor subtotal+tax) may carry an intentional edit, so it needs an
        // explicit force from a human.
        const subtotal = coItemsSubtotal(items.map(i => ({ quantity: i.quantity, unitCost: Number(i.unitCost) })));
        const estimateTax = await tx.estimate.findUnique({
            where: { id: co.estimateId },
            select: { taxExempt: true, taxRatePercent: true, taxRateName: true },
        });
        const expectedBilled = rc(subtotal + rc(subtotal * coTaxRate(estimateTax)));
        const verdict = classify(stored, subtotal, expectedBilled, items.length);
        if (verdict === "no-items") {
            return { ok: false as const, error: `${co.code} has no line items — nothing to recompute from; review by hand.` };
        }
        if (verdict === "ok") {
            return { ok: true as const, changed: false, code: co.code, totalAmount: stored, note: "Already equals the item subtotal." };
        }
        if (verdict === "drift" && !force) {
            return { ok: false as const, error: `${co.code} is a drift row (stored $${stored.toFixed(2)} matches neither the item subtotal $${subtotal.toFixed(2)} nor subtotal+tax $${expectedBilled.toFixed(2)}) — pass force:true only after a human confirms the items are canonical.` };
        }
        await tx.changeOrder.update({
            where: { id: changeOrderId },
            data: { totalAmount: subtotal, balanceDue: subtotal },
        });
        return {
            ok: true as const, changed: true, code: co.code, title: co.title, projectId: co.projectId, verdict,
            before: { totalAmount: stored, balanceDue: balance },
            after: { totalAmount: subtotal, balanceDue: subtotal },
        };
    }, { timeout: 15_000 });

    // Best-effort audit trail — the correction is already committed.
    if (result.ok && result.changed) {
        try {
            await prisma.activityLog.create({
                data: {
                    projectId: result.projectId,
                    actorType: "SYSTEM",
                    actorName: "CO audit repair",
                    action: "corrected_change_order_total",
                    entityType: "change_order",
                    entityId: changeOrderId,
                    entityName: `${result.code} — ${result.title}`,
                    metadata: JSON.stringify({
                        reason: "tax-inclusive totalAmount left by pre-2026-07-09 CO editor",
                        verdict: result.verdict,
                        before: result.before,
                        after: result.after,
                    }),
                },
            });
        } catch { /* activity feed only */ }
    }

    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
