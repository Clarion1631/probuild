import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";
import { getProjectLead, getLeadsForLinking, getUnreadMessageCount } from "@/lib/actions";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
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
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) redirect("/login");

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        select: { id: true, role: true },
    });

    if (!user) redirect("/login");

    // Non-admin/manager users must have explicit ProjectAccess
    if (user.role !== "ADMIN" && user.role !== "MANAGER") {
        const access = await prisma.projectAccess.findUnique({
            where: { userId_projectId: { userId: user.id, projectId: id } },
        });
        if (!access) {
            // Also check crew assignment as fallback
            const crewAccess = await prisma.project.findFirst({
                where: { id, crew: { some: { id: user.id } } },
                select: { id: true },
            });
            if (!crewAccess) redirect("/projects");
        }
    }

    const lead = await getProjectLead(id);
    const allLeads = await getLeadsForLinking();
    const unreadCount = await getUnreadMessageCount(id, "TEAM");

    return (
        <div className="flex h-full -mx-6 -my-6 bg-slate-50">
            <ProjectInnerSidebar
                projectId={id}
                lead={lead ? { id: lead.id, name: lead.name } : null}
                availableLeads={JSON.parse(JSON.stringify(allLeads))}
                unreadMessageCount={unreadCount}
            />
            <div className="flex-1 p-6 overflow-y-auto w-full">
                {children}
            </div>
        </div>
    );
}

