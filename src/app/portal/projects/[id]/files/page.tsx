import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getPortalVisibility } from "@/lib/actions";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import Link from "next/link";
import PortalFileBrowser from "@/components/PortalFileBrowser";

export const dynamic = "force-dynamic";

export default async function PortalFilesPage(props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    const projectId = params.id;

    const visibility = await getPortalVisibility(projectId);
    if (!visibility.isPortalEnabled || !visibility.showFiles) {
        return notFound();
    }

    const staffSession = await getServerSession(authOptions);
    const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

    if (!isStaff) {
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return notFound();
        const project = await prisma.project.findFirst({
            where: { id: projectId, clientId: sessionClientId },
            select: { id: true },
        });
        if (!project) return notFound();
    }

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true },
    });
    if (!project) return notFound();

    return (
        <div className="max-w-4xl mx-auto py-8 px-4">
            <div className="mb-6 flex items-center justify-between">
                <Link href={`/portal/projects/${projectId}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition shadow-sm w-fit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back to Project
                </Link>
                <div className="text-right">
                    <p className="text-sm text-slate-500">{project.name}</p>
                </div>
            </div>

            <div className="hui-card p-6">
                <PortalFileBrowser projectId={projectId} />
            </div>
        </div>
    );
}
