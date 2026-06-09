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

    // Support sequential numeric ID double-routing lookups by resolving to the canonical CUID
    const isNumeric = (str: string) => /^\d+$/.test(str);
    let resolvedId = id;

    if (isNumeric(id)) {
        const lead = await prisma.lead.findFirst({
            where: { number: parseInt(id, 10) },
            select: { id: true }
        });
        if (lead) {
            redirect(`/leads/${lead.id}`);
        } else {
            redirect("/projects");
        }
    }

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
        where: { id: resolvedId },
        select: {
            id: true,
            name: true,
            client: { select: { name: true } },
            project: { select: { id: true, name: true, deletedAt: true } },
        },
    });
    if (!lead) notFound();

    async function handleConvert() {
        "use server";
        await convertLeadToProject(resolvedId);
        redirect("/projects");
    }

    const linkedEntity = lead.project && !lead.project.deletedAt
        ? { type: "project" as const, id: lead.project.id, name: lead.project.name }
        : null;

    return (
        <div className="flex h-full -mx-6 -my-6 bg-hui-background overflow-hidden">
            <EntitySidebar
                entity={{ type: "lead", id: resolvedId, name: lead.name, clientName: lead.client?.name }}
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
