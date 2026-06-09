import { NextRequest, NextResponse } from "next/server";
import { getQBSettings, saveQBSettings } from "@/lib/integration-store";
import { syncClientToQB, syncProjectToQB, refreshQBToken } from "@/lib/quickbooks";
import { prisma } from "@/lib/prisma";

async function getTokens() {
    const qb = await getQBSettings();
    if (!qb.connected || !qb.accessToken || !qb.refreshToken || !qb.realmId) {
        throw new Error("QuickBooks not connected");
    }

    try {
        const fresh = await refreshQBToken(qb.refreshToken);
        await saveQBSettings({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
        return { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, realmId: qb.realmId };
    } catch {
        return { accessToken: qb.accessToken, refreshToken: qb.refreshToken, realmId: qb.realmId };
    }
}

export async function POST(req: NextRequest) {
    try {
        const { projectId } = await req.json();
        if (!projectId) {
            return NextResponse.json({ error: "projectId is required" }, { status: 400 });
        }

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: { client: true }
        });

        if (!project) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        const tokens = await getTokens();

        // 1. Sync Client
        let qbCustomerId = project.client.qbCustomerId;
        if (!qbCustomerId) {
            qbCustomerId = await syncClientToQB(tokens, {
                name: project.client.name,
                email: project.client.email || null,
                primaryPhone: project.client.primaryPhone || null,
                addressLine1: project.client.addressLine1 || null,
                city: project.client.city || null,
                state: project.client.state || null,
                zipCode: project.client.zipCode || null,
            });
            // Save to DB
            await prisma.client.update({
                where: { id: project.clientId },
                data: { qbCustomerId }
            });
        }

        // 2. Sync Project
        const qbProjectId = await syncProjectToQB(tokens, {
            name: project.name,
            clientName: project.client.name,
        }, qbCustomerId);

        // Save to DB
        await prisma.project.update({
            where: { id: projectId },
            data: {
                qbProjectId,
                qbSyncedAt: new Date(),
            }
        });

        return NextResponse.json({ success: true, qbProjectId });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Sync failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
