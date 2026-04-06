import { NextRequest, NextResponse } from "next/server";
import { getQBSettings, saveQBSettings } from "@/lib/integration-store";
import { syncEstimateToQB, syncInvoiceToQB, refreshQBToken } from "@/lib/quickbooks";
import { prisma } from "@/lib/prisma";

async function getTokens() {
    const qb = await getQBSettings();
    if (!qb.connected || !qb.accessToken || !qb.refreshToken || !qb.realmId) {
        throw new Error("QuickBooks not connected");
    }

    // Try refresh if token might be stale (QB tokens last 1 hour)
    try {
        const fresh = await refreshQBToken(qb.refreshToken);
        await saveQBSettings({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
        return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, realmId: qb.realmId };
    } catch {
        // Use existing token
        return { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId };
    }
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

        const tokens = await getTokens();

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

            const result = await syncEstimateToQB(tokens, {
                id: estimate.id,
                code: estimate.code,
                title: estimate.title,
                totalAmount: estimate.totalAmount,
                items: estimate.items.map(i => ({
                    name: i.name,
                    quantity: i.quantity,
                    unitCost: i.unitCost,
                    total: i.total,
                    type: i.type,
                })),
                client: { name: client.name, email: client.email ?? null },
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

            const result = await syncInvoiceToQB(tokens, {
                code: invoice.code,
                totalAmount: invoice.totalAmount,
                balanceDue: invoice.balanceDue,
                client: { name: invoice.client.name, email: invoice.client.email ?? null },
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
