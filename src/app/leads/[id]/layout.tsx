import EntitySidebar from "@/components/EntitySidebar";
import ErrorBoundary from "@/components/ErrorBoundary";
import { getSessionOrDev } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { convertLeadToProject } from "@/lib/actions";
import { notFound, redirect } from "next/navigation";

export default async function LeadLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;

    const session = await getSessionOrDev();
    if (!session?.user?.email) redirect("/login");

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
        include: { permissions: true },
    });

    if (!user && process.env.NODE_ENV !== "development") redirect("/login");
    const effectiveUser = user ?? { role: "ADMIN", permissions: null };

    if (!hasPermission(effectiveUser, "leadAccess")) {
        redirect("/projects");
    }

    const lead = await prisma.lead.findUnique({
        where: { id },
        select: {
            id: true,
            name: true,
            client: { select: { name: true } },
            project: { select: { id: true, name: true } },
        },
    });
    if (!lead) notFound();

    async function handleConvert() {
        "use server";
        await convertLeadToProject(id);
        redirect("/projects");
    }

    const linkedEntity = lead.project
        ? { type: "project" as const, id: lead.project.id, name: lead.project.name }
        : null;

    return (
        <div className="flex h-full -mx-6 -my-6 bg-hui-background overflow-hidden">
            <EntitySidebar
                entity={{ type: "lead", id, name: lead.name, clientName: lead.client?.name }}
                linkedEntity={linkedEntity}
                onConvertToProject={handleConvert}
            />
            <div className="flex flex-1 overflow-hidden w-full min-w-0">
                <ErrorBoundary fallbackTitle="Lead error">
                    {children}
                </ErrorBoundary>
            </div>
        </div>
    );
}
