import { NextRequest, NextResponse } from "next/server";
import { getQBSettings, saveQBSettings } from "@/lib/integration-store";
import { syncEstimateToQB, syncInvoiceToQB, ensureQBCustomer, ensureQBServiceItem, type QBTokens } from "@/lib/quickbooks";
import { getFreshQBTokens } from "@/lib/quickbooks-payments";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";

async function resolveCustomerAndItem(
    tokens: QBTokens,
    client: { id: string; name: string; email: string | null; qbCustomerId: string | null }
) {
    const customerId = await ensureQBCustomer(tokens, client);
    if (customerId !== client.qbCustomerId) {
        await prisma.client.update({ where: { id: client.id }, data: { qbCustomerId: customerId } });
    }
    const qb = await getQBSettings();
    let itemId = qb.serviceItemId;
    if (!itemId) {
        itemId = await ensureQBServiceItem(tokens);
        await saveQBSettings({ serviceItemId: itemId });
    }
    return { customerId, itemId };
}

export async function POST(req: NextRequest) {
    try {
        const { type, id } = await req.json();

        if (!type || !id) {
            return NextResponse.json({ error: "type and id required" }, { status: 400 });
        }

        const qb = await getQBSettings();
        if (!qb.connected) {
            return NextResponse.json({ error: "QuickBooks not connected", notConnected: true }, { status: 400 });
        }

        const tokens = await getFreshQBTokens();

        if (type === "estimate") {
            const estimate = await prisma.estimate.findUnique({
                where: { id },
                select: {
                    id: true, code: true, title: true, status: true,
                    totalAmount: true, balanceDue: true, createdAt: true, projectId: true,
                    items: { select: { name: true, quantity: true, unitCost: true, total: true, type: true } },
                    project: { include: { client: true } },
                },
            });
            if (!estimate) return NextResponse.json({ error: "Estimate not found" }, { status: 404 });

            const client = estimate.project?.client;
            if (!client) return NextResponse.json({ error: "No client attached to estimate" }, { status: 400 });

            const { customerId, itemId } = await resolveCustomerAndItem(tokens, {
                id: client.id, name: client.name, email: client.email ?? null, qbCustomerId: client.qbCustomerId ?? null,
            });

            const result = await syncEstimateToQB(tokens, {
                id: estimate.id,
                code: estimate.code,
                title: estimate.title,
                totalAmount: toNum(estimate.totalAmount),
                items: estimate.items.map(i => ({
                    name: i.name,
                    quantity: i.quantity,
                    unitCost: toNum(i.unitCost),
                    total: toNum(i.total),
                    type: i.type,
                })),
                customerId,
                itemId,
                project: estimate.project ? { name: estimate.project.name } : null,
            }, qb.glMappings || {});

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
                });

                const result = await syncInvoiceToQB(tokens, {
                    code: invoice.code,
                    totalAmount: toNum(invoice.totalAmount),
                    balanceDue: toNum(invoice.balanceDue),
                    customerId,
                    itemId,
                    project: invoice.project ? { name: invoice.project.name } : null,
                });

            return NextResponse.json({ success: true, qbId: result.qbId, qbUrl: result.qbUrl });
        }

        return NextResponse.json({ error: "Unknown type" }, { status: 400 });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Sync failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
