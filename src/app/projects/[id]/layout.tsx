import EntitySidebar from "@/components/EntitySidebar";
import ErrorBoundary from "@/components/ErrorBoundary";
import { getUnreadMessageCount } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
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

    const [unreadCount, project] = await Promise.all([
        getUnreadMessageCount(id, "TEAM"),
        prisma.project.findUnique({
            where: { id },
            select: {
                name: true,
                client: { select: { name: true } },
                lead: { select: { id: true, name: true } },
            },
        }),
    ]);

    const linkedEntity = project?.lead
        ? { type: "lead" as const, id: project.lead.id, name: project.lead.name }
        : null;

    return (
        <div className="flex h-full -mx-6 -my-6 bg-slate-50">
            <EntitySidebar
                entity={{ type: "project", id, name: project?.name ?? "", clientName: project?.client?.name }}
                linkedEntity={linkedEntity}
                unreadMessageCount={unreadCount}
            />
            <div className="flex-1 p-6 overflow-y-auto overflow-x-hidden w-full min-w-0">
                <ErrorBoundary fallbackTitle="Project error">
                    {children}
                </ErrorBoundary>
            </div>
        </div>
    );
}

