import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { coTaxRate, coTaxLabel, coItemsSubtotal, coSectionRowNames, coSectionRowError, classifyCoTotal, effectiveCoTaxInfo } from "@/lib/co-tax";
import { prepareChangeOrderReviewJobsForMutation } from "@/lib/change-order-automation-jobs";

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

// GET and POST share one verdict function (classifyCoTotal, beside the money math it must
// agree with) so a row the audit reports as ok can never be mutated by a follow-up POST —
// and, just as importantly, a row the send/approve guards block can never be reported ok.
const classify = classifyCoTotal;

export async function GET(req: Request) {
    if (!authorized(req)) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

    const cos = await prisma.changeOrder.findMany({
        orderBy: { number: "asc" },
        select: {
            id: true, code: true, title: true, status: true, pricingType: true,
            totalAmount: true, balanceDue: true, createdAt: true, updatedAt: true,
            approvedAt: true, sentAt: true,
            termsTaxExempt: true, termsTaxRateName: true, termsTaxRatePercent: true,
            paymentSchedules: { select: { amount: true } },
            project: { select: { id: true, name: true } },
            estimate: { select: { code: true, taxExempt: true, taxRatePercent: true, taxRateName: true } },
            items: { select: { name: true, type: true, quantity: true, unitCost: true, total: true } },
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
        const subtotal = coItemsSubtotal(co.items.map(i => ({ type: i.type, quantity: i.quantity, unitCost: Number(i.unitCost) })));
        const taxInfo = effectiveCoTaxInfo(co, co.estimate);
        const rate = coTaxRate(taxInfo);
        const tax = rc(subtotal * rate);
        const expectedBilled = rc(subtotal + tax); // what billing charges once fixed
        const inflated = rc(stored - subtotal);
        const sectionNames = coSectionRowNames(co.items);
        const verdict = classify(stored, subtotal, expectedBilled, co.items.length, sectionNames.length, co.pricingType);
        // billChangeOrderCore refuses a signed CO whose schedule rows do not sum to the
        // subtotal, so a repair that moves totalAmount without them trades one stuck state
        // for a later one. Surfaced here, refused by POST.
        const scheduleRowCents = co.paymentSchedules.map(r => Math.round(Number(r.amount) * 100));
        const scheduleCents = scheduleRowCents.reduce((s, c) => s + c, 0);

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
            pricingType: co.pricingType,
            verdict,
            scheduleRowCount: co.paymentSchedules.length,
            scheduleTotal: scheduleCents / 100,
            scheduleMatchesSubtotal: co.paymentSchedules.length === 0
                || (scheduleCents === Math.round(subtotal * 100) && scheduleRowCents.every(c => c > 0)),
            storedTotalAmount: stored,
            storedBalanceDue: rc(Number(co.balanceDue)),
            itemCount: co.items.length,
            sectionRowNames: sectionNames,
            itemSubtotal: subtotal,
            storedLineTotalsSum: rc(co.items.reduce((s, i) => s + Number(i.total), 0)),
            taxTreatment: coTaxLabel(taxInfo),
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
            hasSections: rows.filter(r => r.verdict === "has-sections").length,
            costPlus: rows.filter(r => r.verdict === "cost-plus").length,
            unpriced: rows.filter(r => r.verdict === "unpriced").length,
            scheduleOutOfSync: rows.filter(r => !r.scheduleMatchesSubtotal).length,
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
        const locked = await tx.$queryRaw<Array<{
            id: string; code: string; title: string; status: string; pricingType: string;
            totalAmount: unknown; balanceDue: unknown; projectId: string; estimateId: string;
            termsTaxExempt: boolean | null; termsTaxRateName: string | null;
            termsTaxRatePercent: { toString(): string } | null;
            clientSignatureUrl: string | null; approvedBy: string | null; approvedAt: Date | null;
            companySignatureUrl: string | null; companySignedBy: string | null; companySignedAt: Date | null;
        }>>`
            SELECT "id", "code", "title", "status", "pricingType", "totalAmount", "balanceDue", "projectId", "estimateId",
                   "termsTaxExempt", "termsTaxRateName", "termsTaxRatePercent",
                   "clientSignatureUrl", "approvedBy", "approvedAt",
                   "companySignatureUrl", "companySignedBy", "companySignedAt"
            FROM "ChangeOrder" WHERE "id" = ${changeOrderId} FOR UPDATE`;
        const co = locked[0];
        if (!co) return { ok: false as const, error: "Change order not found" };
        if (co.status !== "Draft" && co.status !== "Sent") {
            return { ok: false as const, error: `${co.code} is "${co.status}" — only Draft/Sent change orders may be auto-corrected. Approved rows need human review (billed milestone).` };
        }
        if ([
            co.clientSignatureUrl,
            co.approvedBy,
            co.approvedAt,
            co.companySignatureUrl,
            co.companySignedBy,
            co.companySignedAt,
        ].some(value => value != null)) {
            return { ok: false as const, error: `${co.code} has signature or approval audit data — automated repair is forbidden. Review the signed scope by hand.` };
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
            select: { name: true, type: true, quantity: true, unitCost: true },
        });
        // Re-derive the verdict under the lock — the repair only applies to the
        // tax-inclusive-total bug. A drift row (total matches neither subtotal
        // nor subtotal+tax) may carry an intentional edit, so it needs an
        // explicit force from a human.
        const subtotal = coItemsSubtotal(items.map(i => ({ type: i.type, quantity: i.quantity, unitCost: Number(i.unitCost) })));
        const [estimateTax] = await tx.$queryRaw<Array<{
            taxExempt: boolean; taxRatePercent: { toString(): string } | null; taxRateName: string | null;
        }>>`
            SELECT "taxExempt", "taxRatePercent", "taxRateName"
            FROM "Estimate" WHERE "id" = ${co.estimateId} FOR SHARE`;
        const taxInfo = effectiveCoTaxInfo(co, estimateTax);
        const expectedBilled = rc(subtotal + rc(subtotal * coTaxRate(taxInfo)));
        const sectionNames = coSectionRowNames(items);
        const verdict = classify(stored, subtotal, expectedBilled, items.length, sectionNames.length, co.pricingType);
        // Not repairable here: writing back a subtotal that excludes the headers would leave
        // the rows in place and a total nobody can justify, and a later GET would call it
        // "ok" while send and approve stay correctly blocked. Fix the items, not the total.
        if (verdict === "has-sections") {
            return { ok: false as const, error: coSectionRowError(co.code, sectionNames) };
        }
        if (verdict === "cost-plus") {
            // Its total comes from actuals, not these items, and the send/approve guards skip
            // the subtotal comparison for it — so there is nothing here to be out of sync, and
            // overwriting it with the item subtotal would destroy a legitimate number.
            return { ok: false as const, error: `${co.code} is COST_PLUS — its total bills from actuals, not from the item subtotal, so there is nothing for this repair to reconcile.` };
        }
        if (verdict === "no-items") {
            return { ok: false as const, error: `${co.code} has no line items — nothing to recompute from; review by hand.` };
        }
        if (verdict === "unpriced") {
            return { ok: false as const, error: `${co.code} has a nonpositive total ($${stored.toFixed(2)}) or item subtotal ($${subtotal.toFixed(2)}) — send and approve reject it as unpriced, and writing the subtotal back would not change that. Price the items first.` };
        }
        if (verdict === "ok") {
            // Cents-exact, so this really is a no-op: send and approve compare the same
            // two integers and will let the row through.
            return { ok: true as const, changed: false, code: co.code, totalAmount: stored, note: "Already equals the item subtotal." };
        }
        if (verdict === "drift" && force !== true) {
            // Sub-cent drift is a rounding artifact, not an edit anyone made on purpose —
            // say so, because that row is hard-blocked from send and approve until it is fixed.
            const rounding = Math.abs(Math.round(stored * 100) - Math.round(subtotal * 100)) <= 1
                ? ` It is off by a single cent, which send and approve reject outright, so force:true is the intended fix here.`
                : "";
            return { ok: false as const, error: `${co.code} is a drift row (stored $${stored.toFixed(2)} matches neither the item subtotal $${subtotal.toFixed(2)} nor subtotal+tax $${expectedBilled.toFixed(2)}) — pass force:true only after a human confirms the items are canonical.${rounding}` };
        }
        // billChangeOrderCore refuses a signed CO whose schedule rows do not sum to the
        // subtotal ("schedule amounts are out of sync with the signed subtotal"). Moving
        // totalAmount out from under them would unstick send and approve only to wedge
        // billing later, so refuse rather than guess how to redistribute the difference —
        // which row absorbs it is a human's call, not this route's.
        const schedules = await tx.changeOrderPaymentSchedule.findMany({
            where: { changeOrderId },
            select: { amount: true },
        });
        if (schedules.length) {
            const rowCents = schedules.map(r => Math.round(Number(r.amount) * 100));
            const scheduleCents = rowCents.reduce((s, c) => s + c, 0);
            if (scheduleCents !== Math.round(subtotal * 100)) {
                return { ok: false as const, error: `${co.code} has ${schedules.length} payment schedule row(s) summing to $${(scheduleCents / 100).toFixed(2)}, which is not the item subtotal $${subtotal.toFixed(2)}. Billing rejects that mismatch after signature, so rebalance the schedule in the editor instead of resetting the total here.` };
            }
            // Billing also refuses any nonpositive row ("schedule rows reach or exceed the
            // subtotal before the final remainder"), so a sum check alone would still let a
            // 0.00 or negative row through to fail after signature.
            if (rowCents.some(c => c <= 0)) {
                return { ok: false as const, error: `${co.code} has a payment schedule row of $0.00 or less. Billing refuses those after signature, so fix the schedule in the editor before resetting the total here.` };
            }
        }
        await prepareChangeOrderReviewJobsForMutation(tx, changeOrderId);
        await tx.changeOrder.update({
            where: { id: changeOrderId },
            data: {
                totalAmount: subtotal,
                balanceDue: subtotal,
                ...(co.status === "Sent" ? {
                    status: "Draft",
                    sentAt: null,
                    viewedAt: null,
                    termsTaxExempt: null,
                    termsTaxRateName: null,
                    termsTaxRatePercent: null,
                } : {}),
                revision: { increment: 1 },
            },
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
