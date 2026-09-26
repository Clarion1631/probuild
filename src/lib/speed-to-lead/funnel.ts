import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * `get_lead_funnel_summary` (counts only, SELECT only, in READONLY_TOOLS).
 * Every query here is a COUNT/aggregate — no row content is returned. v1a
 * has no outreach to group by; alerts (by channel and status) replace it.
 */
export interface LeadFunnelSummary {
    windowDays: number;
    intakeBySourceAndVerdict: { source: string; verdict: string | null; count: number }[];
    alertsByChannelAndStatus: { channel: string; status: string; count: number }[];
    booked: number;
    called: number;
}

export async function getLeadFunnelSummary(windowDays = 7, db: PrismaClient = prisma): Promise<LeadFunnelSummary> {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const intake = await db.leadIntakeEvent.groupBy({
        by: ["source", "verdict"],
        where: { receivedAt: { gte: since } },
        _count: { _all: true },
    });
    const alerts = await db.leadAlert.groupBy({
        by: ["channel", "status"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
    });
    const [booked, called] = await Promise.all([
        db.lead.count({ where: { bookedAt: { gte: since } } }),
        db.lead.count({ where: { calledAt: { gte: since } } }),
    ]);

    return {
        windowDays,
        intakeBySourceAndVerdict: intake.map(r => ({ source: r.source, verdict: r.verdict, count: r._count._all })),
        alertsByChannelAndStatus: alerts.map(r => ({ channel: r.channel, status: r.status, count: r._count._all })),
        booked,
        called,
    };
}
