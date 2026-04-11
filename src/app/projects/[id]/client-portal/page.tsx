export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getPortalVisibility } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import PortalVisibilityToggles from "../settings/PortalVisibilityToggles";
import ClientPortalShare from "./ClientPortalShare";
import Link from "next/link";

interface Props {
    params: Promise<{ id: string }>;
}

export default async function ClientPortalPage({ params }: Props) {
    const { id } = await params;

    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const [project, visibility] = await Promise.all([
        prisma.project.findUnique({
            where: { id },
            include: { client: { select: { name: true, email: true } } },
        }),
        getPortalVisibility(id),
    ]);

    if (!project) return <div className="p-8 text-red-500">Project not found.</div>;

    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/portal/projects/${id}`;
    const clientEmail = project.client?.email ?? null;

    const initialState = {
        isPortalEnabled: visibility?.isPortalEnabled ?? true,
        showEstimates: visibility?.showEstimates ?? true,
        showInvoices: visibility?.showInvoices ?? true,
        showContracts: visibility?.showContracts ?? true,
        showSelections: visibility?.showSelections ?? false,
        showMoodBoards: visibility?.showMoodBoards ?? false,
        showSchedule: visibility?.showSchedule ?? false,
        showFiles: visibility?.showFiles ?? false,
        showDailyLogs: visibility?.showDailyLogs ?? false,
        showMessages: visibility?.showMessages ?? true,
        lastSharedAt: visibility?.lastSharedAt ?? null,
        lastShareEmailId: visibility?.lastShareEmailId ?? null,
        lastShareEmailStatus: visibility?.lastShareEmailStatus ?? null,
    };

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Client Dashboard</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Control what <span className="font-medium">{project.client?.name ?? "your client"}</span> can see in their portal.
                    </p>
                </div>
                <Link
                    href={portalUrl}
                    target="_blank"
                    className="hui-btn hui-btn-secondary text-sm flex items-center gap-2"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    Preview Portal
                </Link>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6 items-start">
                {/* Visibility Toggles */}
                <div className="hui-card p-6">
                    <h2 className="text-base font-semibold text-hui-textMain mb-4">Visible Sections</h2>
                    <PortalVisibilityToggles projectId={id} initialState={initialState} />
                </div>

                {/* Share Panel */}
                <ClientPortalShare
                    projectId={id}
                    portalUrl={portalUrl}
                    clientEmail={clientEmail}
                    lastSharedAt={initialState.lastSharedAt ? initialState.lastSharedAt.toString() : null}
                />
            </div>
        </div>
    );
}
