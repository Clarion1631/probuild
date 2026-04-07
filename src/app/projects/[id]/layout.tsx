import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";
import ProjectMessagingToggle from "@/components/ProjectMessagingToggle";
import ErrorBoundary from "@/components/ErrorBoundary";
import { getProjectLead, getLeadsForLinking, getUnreadMessageCount } from "@/lib/actions";
import { authOptions, getSessionOrDev } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export default async function ProjectLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;

    // --- Permission check: does this user have access to this project? ---
    const session = await getSessionOrDev();
    if (!session?.user?.email) redirect("/login");

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, role: true },
    });

    if (!user && process.env.NODE_ENV !== "development") redirect("/login");
    const effectiveUser = user ?? { id: "dev", role: "ADMIN" };

    // Non-admin/manager users must have explicit ProjectAccess
    if (effectiveUser.role !== "ADMIN" && effectiveUser.role !== "MANAGER") {
        const access = await prisma.projectAccess.findUnique({
            where: { userId_projectId: { userId: effectiveUser.id, projectId: id } },
        });
        if (!access) {
            // Also check crew assignment as fallback
            const crewAccess = await prisma.project.findFirst({
                where: { id, crew: { some: { id: effectiveUser.id } } },
                select: { id: true },
            });
            if (!crewAccess) redirect("/projects");
        }
    }

    const [lead, allLeads, unreadCount, project] = await Promise.all([
        getProjectLead(id),
        getLeadsForLinking(),
        getUnreadMessageCount(id, "TEAM"),
        prisma.project.findUnique({
            where: { id },
            select: {
                client: { select: { name: true, email: true, primaryPhone: true } },
                estimates: { select: { id: true, code: true, title: true, status: true }, orderBy: { createdAt: "desc" } },
            },
        }),
    ]);

    return (
        <div className="flex h-full -mx-6 -my-6 bg-slate-50">
            <ProjectInnerSidebar
                projectId={id}
                lead={lead ? { id: lead.id, name: lead.name } : null}
                availableLeads={JSON.parse(JSON.stringify(allLeads))}
                unreadMessageCount={unreadCount}
            />
            <div className="flex-1 p-6 overflow-y-auto w-full">
                <ErrorBoundary fallbackTitle="Project error">
                    {children}
                </ErrorBoundary>
            </div>
            <ProjectMessagingToggle
                projectId={id}
                clientName={project?.client?.name || "Client"}
                clientEmail={project?.client?.email || null}
                clientPhone={(project?.client as any)?.primaryPhone || null}
                estimates={project?.estimates ?? []}
                currentUserName={session.user.name || undefined}
                currentUserEmail={session.user.email || undefined}
                unreadCount={unreadCount}
            />
        </div>
    );
}

