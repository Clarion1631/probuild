import { NextRequest, NextResponse } from "next/server";
import { getQBSettings, saveQBSettings } from "@/lib/integration-store";
import { syncTimeEntryToQB, refreshQBToken } from "@/lib/quickbooks";
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
        const { timeEntryIds } = await req.json();
        if (!timeEntryIds || !Array.isArray(timeEntryIds) || timeEntryIds.length === 0) {
            return NextResponse.json({ error: "timeEntryIds array required" }, { status: 400 });
        }

        const qb = await getQBSettings();
        if (!qb.connected) {
            return NextResponse.json({ error: "QuickBooks not connected" }, { status: 400 });
        }

        const employeeMappings = (qb as any).employeeMappings || {};
        const tokens = await getTokens();

        const timeEntries = await prisma.timeEntry.findMany({
            where: { id: { in: timeEntryIds } },
            include: { project: true, user: true },
        });

        const syncedIds: string[] = [];
        const errors: string[] = [];

        for (const entry of timeEntries) {
            try {
                if (!entry.project.qbProjectId) {
                    throw new Error(`Project "${entry.project.name}" must be synced to QuickBooks first.`);
                }

                const workerMap = employeeMappings[entry.userId];
                if (!workerMap) {
                    throw new Error(`User "${entry.user.name || entry.user.email}" is not mapped to a QuickBooks worker.`);
                }

                const [workerType, workerId] = workerMap.split(":");
                if (!workerType || !workerId) {
                    throw new Error(`Invalid worker mapping for User "${entry.user.name || entry.user.email}".`);
                }

                const dateStr = entry.startTime.toISOString().split("T")[0];
                const hours = entry.durationHours || 0;
                
                const qbTimeActivityId = await syncTimeEntryToQB(
                    tokens,
                    {
                        date: dateStr,
                        hours,
                        description: entry.editNotes || "Labor hours logged in ProBuild",
                        qbProjectId: entry.project.qbProjectId,
                    },
                    {
                        type: workerType as "Employee" | "Vendor",
                        id: workerId,
                    }
                );

                await prisma.timeEntry.update({
                    where: { id: entry.id },
                    data: {
                        qbTimeActivityId,
                        qbSyncedAt: new Date(),
                    },
                });

                syncedIds.push(entry.id);
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Failed to sync entry";
                errors.push(`TimeEntry (${entry.startTime.toLocaleDateString()}): ${msg}`);
            }
        }

        return NextResponse.json({
            success: true,
            syncedCount: syncedIds.length,
            syncedIds,
            errors,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Sync failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
