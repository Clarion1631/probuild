import { NextRequest, NextResponse } from "next/server";
import { getQBSettings, saveQBSettings } from "@/lib/integration-store";
import {
    syncEstimateToQB, syncInvoiceToQB, ensureQBCustomer, ensureQBServiceItem,
    createRouteDeadline, isQBBudgetExhaustedError, isQBTimeoutError, isQboConnectionFailure,
    type QBTokens, type RouteDeadline,
} from "@/lib/quickbooks";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";

/**
 * Whole-request budget. This route makes a serial CHAIN of QuickBooks calls —
 * token refresh, customer ensure, service-item ensure, then the document sync —
 * and every one of them used to be unbounded. During the 2026-09-01 outage that
 * is exactly how a single request sat until the platform killed it: four calls
 * that are each individually legal still add up past the ceiling.
 */
const QB_SYNC_BUDGET_MS = 50_000;

export const maxDuration = 60;

async function resolveCustomerAndItem(
    tokens: QBTokens,
    client: { id: string; name: string; email: string | null; qbCustomerId: string | null },
    deadline: RouteDeadline,
) {
    const customerId = await ensureQBCustomer(tokens, client, deadline);
    if (customerId !== client.qbCustomerId) {
        await prisma.client.update({ where: { id: client.id }, data: { qbCustomerId: customerId } });
    }
    const qb = await getQBSettings();
    let itemId = qb.serviceItemId;
    if (!itemId) {
        itemId = await ensureQBServiceItem(tokens, deadline);
        await saveQBSettings({ serviceItemId: itemId });
    }
    return { customerId, itemId };
}

export async function POST(req: NextRequest) {
    // ONE budget for the request, created at the entry and threaded through
    // every QuickBooks call below.
    const deadline = createRouteDeadline(QB_SYNC_BUDGET_MS);
    try {
        const { type, id } = await req.json();

        if (!type || !id) {
            return NextResponse.json({ error: "type and id required" }, { status: 400 });
        }

        const qb = await getQBSettings();
        if (!qb.connected) {
            return NextResponse.json({ error: "QuickBooks not connected", notConnected: true }, { status: 400 });
        }

        const tokens = await getFreshQBTokens(deadline);

        if (type === "estimate") {
            const estimate = await prisma.estimate.findUnique({
                where: { id },
                select: {
                    id: true, code: true, title: true, status: true,
                    totalAmount: true, balanceDue: true, createdAt: true, projectId: true,
                    // id/parentId feed the section-header detection in `buildQBEstimateLines`.
                    // orderBy keeps QB LineNum in the estimate's own row order rather than
                    // whatever order Postgres happens to return.
                    items: {
                        orderBy: [{ order: "asc" }, { id: "asc" }],
                        select: { id: true, parentId: true, name: true, quantity: true, unitCost: true, total: true, type: true },
                    },
                    project: { include: { client: true } },
                },
            });
            if (!estimate) return NextResponse.json({ error: "Estimate not found" }, { status: 404 });

            const client = estimate.project?.client;
            if (!client) return NextResponse.json({ error: "No client attached to estimate" }, { status: 400 });

            const { customerId, itemId } = await resolveCustomerAndItem(tokens, {
                id: client.id, name: client.name, email: client.email ?? null, qbCustomerId: client.qbCustomerId ?? null,
            }, deadline);

            const result = await syncEstimateToQB(tokens, {
                id: estimate.id,
                code: estimate.code,
                title: estimate.title,
                totalAmount: toNum(estimate.totalAmount),
                // Passed through whole — `syncEstimateToQB` drops section headers itself, so the
                // hierarchy fields have to survive this mapping.
                items: estimate.items.map(i => ({
                    id: i.id,
                    parentId: i.parentId,
                    name: i.name,
                    quantity: i.quantity,
                    unitCost: toNum(i.unitCost),
                    total: toNum(i.total),
                    type: i.type,
                })),
                customerId,
                itemId,
                project: estimate.project ? { name: estimate.project.name } : null,
            }, qb.glMappings || {}, deadline);

            return NextResponse.json({ success: true, qbId: result.qbId, qbUrl: result.qbUrl });
        }

        if (type === "invoice") {
            const invoice = await prisma.invoice.findUnique({
                where: { id },
                include: {
                    client: true,
                    project: true,
                },
            });
            if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

                const { customerId, itemId } = await resolveCustomerAndItem(tokens, {
                    id: invoice.client.id, name: invoice.client.name,
                    email: invoice.client.email ?? null, qbCustomerId: invoice.client.qbCustomerId ?? null,
                }, deadline);

                const result = await syncInvoiceToQB(tokens, {
                    code: invoice.code,
                    totalAmount: toNum(invoice.totalAmount),
                    balanceDue: toNum(invoice.balanceDue),
                    customerId,
                    itemId,
                    project: invoice.project ? { name: invoice.project.name } : null,
                }, deadline);

            return NextResponse.json({ success: true, qbId: result.qbId, qbUrl: result.qbUrl });
        }

        return NextResponse.json({ error: "Unknown type" }, { status: 400 });
    } catch (err) {
        // Out of budget, or QuickBooks unreachable: 503 + retry, not a 500. The
        // caller should come back rather than treat an outage as a rejected
        // document.
        if (isQBBudgetExhaustedError(err) || isQboConnectionFailure(err)) {
            return NextResponse.json(
                { error: isQBTimeoutError(err) ? "QuickBooks did not respond in time" : "QuickBooks is unavailable", retry: true },
                { status: 503 },
            );
        }
        const msg = err instanceof Error ? err.message : "Sync failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
