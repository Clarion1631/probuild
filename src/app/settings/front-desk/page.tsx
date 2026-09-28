import { prisma } from "@/lib/prisma";
import { currentStaffUserOrNull } from "@/lib/permissions";
import { frontDeskMode, frontDeskBookingEnabled, frontDeskMissLineEnabled } from "@/lib/front-desk/constants";
import { speedToLeadMode } from "@/lib/speed-to-lead/constants";
import FrontDeskSettingsPanel from "./FrontDeskSettingsPanel";

/** Front Desk v1 §2.4 — admin-only settings page. */
export default async function FrontDeskSettingsPage() {
    const user = await currentStaffUserOrNull();
    if (user?.role !== "ADMIN") {
        return <div className="p-8">Only an admin can view the Front Desk settings.</div>;
    }

    const [settings, recentCalls, activeTransfer, uncertainBookings] = await Promise.all([
        prisma.companySettings.findUnique({
            where: { id: "singleton" },
            select: {
                frontDeskTakingTransfers: true, frontDeskTakingTransfersBy: true, frontDeskTakingTransfersAt: true,
                frontDeskCalendlyTokenEnc: true, frontDeskCalendlyTokenSetBy: true, frontDeskCalendlyTokenSetAt: true,
                frontDeskCalendlyUserUri: true, frontDeskCalendlyPlan: true,
                frontDeskCalendlyEventTypeUri: true, frontDeskCalendlyTestEventTypeUri: true, frontDeskCalendlyAuthFailedAt: true,
            },
        }),
        prisma.frontDeskCall.findMany({
            orderBy: { createdAt: "desc" },
            take: 20,
            select: { id: true, conversationId: true, isTest: true, outcome: true, leadId: true, createdAt: true },
        }),
        prisma.frontDeskTransfer.findFirst({
            where: { status: { in: ["PREPARED", "DIALING"] } },
            orderBy: { preparedAt: "desc" },
        }),
        prisma.frontDeskBooking.findMany({
            where: { status: "UNCERTAIN" },
            orderBy: { updatedAt: "desc" },
            take: 20,
            select: { id: true, conversationId: true, startTime: true, updatedAt: true },
        }),
    ]);

    return (
        <div className="p-8 max-w-3xl mx-auto space-y-6">
            <div className="hui-card p-6">
                <h1 className="text-lg font-semibold mb-2">Front Desk</h1>
                <dl className="text-sm space-y-1">
                    <div><dt className="inline font-medium">Mode:</dt> <dd className="inline">{frontDeskMode()}</dd></div>
                    <div><dt className="inline font-medium">Booking:</dt> <dd className="inline">{frontDeskBookingEnabled() ? "ON" : "OFF"}</dd></div>
                    <div><dt className="inline font-medium">Miss line:</dt> <dd className="inline">{frontDeskMissLineEnabled() ? "ON" : "OFF"}</dd></div>
                    <div><dt className="inline font-medium">Speed-to-Lead mode:</dt> <dd className="inline">{speedToLeadMode()}</dd></div>
                    {speedToLeadMode() === "OFF" && (
                        <div className="text-amber-700">Warning: Speed-to-Lead is OFF, which forces the front desk OFF too — never pause v1a while routing is on.</div>
                    )}
                    <div><dt className="inline font-medium">Tool secret set:</dt> <dd className="inline">{process.env.FRONT_DESK_TOOL_SECRET ? "yes" : "no"}</dd></div>
                    <div><dt className="inline font-medium">Webhook secret set:</dt> <dd className="inline">{process.env.FRONT_DESK_ELEVENLABS_WEBHOOK_SECRET ? "yes" : "no"}</dd></div>
                    <div><dt className="inline font-medium">Urgent ntfy topic set:</dt> <dd className="inline">{process.env.FRONT_DESK_URGENT_NTFY_TOPIC ? "yes" : "no"}</dd></div>
                </dl>
            </div>

            <FrontDeskSettingsPanel
                takingTransfers={settings?.frontDeskTakingTransfers ?? false}
                takingTransfersBy={settings?.frontDeskTakingTransfersBy ?? null}
                takingTransfersAt={settings?.frontDeskTakingTransfersAt ?? null}
                calendlyConnected={!!settings?.frontDeskCalendlyTokenEnc}
                calendlyTokenSetBy={settings?.frontDeskCalendlyTokenSetBy ?? null}
                calendlyTokenSetAt={settings?.frontDeskCalendlyTokenSetAt ?? null}
                calendlyPlan={settings?.frontDeskCalendlyPlan ?? null}
                calendlyAuthFailedAt={settings?.frontDeskCalendlyAuthFailedAt ?? null}
                liveEventTypeUri={settings?.frontDeskCalendlyEventTypeUri ?? ""}
                testEventTypeUri={settings?.frontDeskCalendlyTestEventTypeUri ?? ""}
                activeTransfer={activeTransfer ? { id: activeTransfer.id, status: activeTransfer.status, callerName: activeTransfer.callerName, preparedAt: activeTransfer.preparedAt } : null}
                recentCalls={recentCalls}
                uncertainBookings={uncertainBookings}
            />
        </div>
    );
}
