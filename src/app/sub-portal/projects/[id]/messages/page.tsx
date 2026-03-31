import { redirect, notFound } from "next/navigation";
import { getSubPortalSession } from "@/lib/sub-portal-auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import ProjectChat from "@/components/ProjectChat";

export default async function SubPortalProjectMessages(props: { params: Promise<{ id: string }> }) {
    const sub = await getSubPortalSession();
    if (!sub) redirect("/sub-portal/login");

    const params = await props.params;
    const projectId = params.id;

    // Verify sub access to project via assignments or projectAccess
    const assignmentCount = await prisma.subTaskAssignment.count({
        where: { subcontractorId: sub.id, task: { projectId } }
    });
    
    const accessCount = await prisma.subcontractorProjectAccess.count({
        where: { subcontractorId: sub.id, projectId }
    });

    if (assignmentCount === 0 && accessCount === 0) return notFound();

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true }
    });

    if (!project) return notFound();

    return (
        <div className="max-w-3xl flex flex-col mx-auto py-8 px-4 h-full">
            {/* Back Button */}
            <div className="mb-6 flex-shrink-0">
                <Link
                    href={`/sub-portal/projects/${projectId}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back to Project
                </Link>
            </div>

            <div className="mb-6 flex-shrink-0">
                <h1 className="text-2xl font-bold text-hui-textMain">Messages</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Conversation with the project management team for <span className="font-medium">{project.name}</span>
                </p>
            </div>

            <div className="flex-1 w-full flex flex-col min-h-0">
                <ProjectChat
                    projectId={projectId}
                    perspective="SUBCONTRACTOR"
                    subcontractorId={sub.id}
                    currentUserName={sub.companyName}
                    currentUserEmail={sub.email}
                />
            </div>
        </div>
    );
}
