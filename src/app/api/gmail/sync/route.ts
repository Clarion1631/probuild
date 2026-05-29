import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncPurchaseOrderEmails } from "@/lib/gmail-sync";

export const dynamic = "force-dynamic";

async function handleSync() {
    try {
        // Fetch recently active Purchase Orders to sync
        const activePOs = await prisma.purchaseOrder.findMany({
            where: {
                status: {
                    in: ["Sent", "Draft"]
                }
            },
            select: {
                id: true,
                code: true
            },
            take: 20 // Limit to prevent timing out on serverless environments
        });

        console.log(`[Gmail Sync Cron] Found ${activePOs.length} active POs to sync.`);
        
        let totalSynced = 0;
        const results = [];

        for (const po of activePOs) {
            try {
                const res = await syncPurchaseOrderEmails(po.code, po.id);
                if (res.success && res.count) {
                    totalSynced += res.count;
                    results.push({ code: po.code, count: res.count });
                }
            } catch (poErr: any) {
                console.error(`[Gmail Sync Cron] Failed to sync PO ${po.code}:`, poErr);
            }
        }

        return NextResponse.json({
            success: true,
            syncedCount: totalSynced,
            results
        });

    } catch (error: any) {
        console.error("[Gmail Sync Cron] Error:", error);
        return NextResponse.json({ error: error.message || "Failed to sync Gmail" }, { status: 500 });
    }
}

export async function GET(req: NextRequest) {
    return handleSync();
}

export async function POST(req: NextRequest) {
    return handleSync();
}
