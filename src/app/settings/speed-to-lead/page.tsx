import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isApprover, speedToLeadMode } from "@/lib/speed-to-lead/constants";
import SpeedToLeadSettingsPanel from "./SpeedToLeadSettingsPanel";

export default async function SpeedToLeadSettingsPage() {
    const session = await getServerSession(authOptions);
    const canManage = isApprover(session?.user?.email);

    if (!canManage) {
        return <div className="p-8">Only the Speed-to-Lead approver can view this page.</div>;
    }

    const [paused, settings, deadAlerts] = await Promise.all([
        prisma.automationSetting.findUnique({ where: { key: "speedToLeadPaused" } }),
        prisma.companySettings.findUnique({
            where: { id: "singleton" },
            select: { leadInboxEmail: true, leadInboxLastPollAt: true, leadInboxLastPollOk: true, leadInboxFailureCount: true },
        }),
        prisma.leadAlert.findMany({
            where: { status: "DEAD" },
            orderBy: { updatedAt: "desc" },
            take: 20,
            select: { id: true, leadId: true, channel: true, lastErrorCategory: true, updatedAt: true },
        }),
    ]);

    return (
        <div className="p-8 max-w-3xl mx-auto space-y-6">
            <div className="hui-card p-6">
                <h1 className="text-lg font-semibold mb-2">Speed-to-Lead</h1>
                <dl className="text-sm space-y-1">
                    <div><dt className="inline font-medium">Mode:</dt> <dd className="inline">{speedToLeadMode()}</dd></div>
                    <div><dt className="inline font-medium">Paused:</dt> <dd className="inline">{paused?.value === "true" ? "yes" : "no"}</dd></div>
                    <div><dt className="inline font-medium">Lead inbox:</dt> <dd className="inline">{settings?.leadInboxEmail ?? "not connected"}</dd></div>
                    <div><dt className="inline font-medium">Last poll:</dt> <dd className="inline">{settings?.leadInboxLastPollAt ? `${settings.leadInboxLastPollAt.toISOString()} (${settings.leadInboxLastPollOk ? "ok" : "failed"})` : "never"}</dd></div>
                    <div><dt className="inline font-medium">Consecutive poll failures:</dt> <dd className="inline">{settings?.leadInboxFailureCount ?? 0}</dd></div>
                </dl>
            </div>

            <SpeedToLeadSettingsPanel paused={paused?.value === "true"} leadInboxConnected={!!settings?.leadInboxEmail} deadAlerts={deadAlerts} />
        </div>
    );
}
