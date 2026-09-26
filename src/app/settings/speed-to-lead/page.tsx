import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isApprover, speedToLeadMode, templateAEnabled } from "@/lib/speed-to-lead/constants";
import { currentFingerprint, readLiveActivation } from "@/lib/speed-to-lead/fingerprint";
import SpeedToLeadSettingsPanel from "./SpeedToLeadSettingsPanel";

export default async function SpeedToLeadSettingsPage() {
    const session = await getServerSession(authOptions);
    const canManage = isApprover(session?.user?.email);

    if (!canManage) {
        return <div className="p-8">Only the Speed-to-Lead approver can view this page.</div>;
    }

    const [paused, templates, latestReadiness, activation] = await Promise.all([
        prisma.automationSetting.findUnique({ where: { key: "speedToLeadPaused" } }),
        prisma.outreachTemplate.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.readinessRecord.findFirst({ orderBy: { createdAt: "desc" } }),
        readLiveActivation(),
    ]);

    return (
        <div className="p-8 max-w-3xl mx-auto space-y-6">
            <div className="hui-card p-6">
                <h1 className="text-lg font-semibold mb-2">Speed-to-Lead</h1>
                <dl className="text-sm space-y-1">
                    <div><dt className="inline font-medium">Mode:</dt> <dd className="inline">{speedToLeadMode()}</dd></div>
                    <div><dt className="inline font-medium">Template A flag:</dt> <dd className="inline">{templateAEnabled() ? "on" : "off"}</dd></div>
                    <div><dt className="inline font-medium">Paused:</dt> <dd className="inline">{paused?.value === "true" ? "yes" : "no"}</dd></div>
                    <div><dt className="inline font-medium">Fingerprint:</dt> <dd className="inline">{currentFingerprint() ?? "(unset)"}</dd></div>
                    <div><dt className="inline font-medium">LIVE activated for current fingerprint:</dt> <dd className="inline">{activation && currentFingerprint() === activation.fingerprint ? "yes" : "no"}</dd></div>
                    <div><dt className="inline font-medium">Latest readiness:</dt> <dd className="inline">{latestReadiness ? `${latestReadiness.passed ? "PASSED" : "FAILED"} at ${latestReadiness.createdAt.toISOString()}` : "never run"}</dd></div>
                </dl>
            </div>

            <SpeedToLeadSettingsPanel paused={paused?.value === "true"} templates={templates} />
        </div>
    );
}
