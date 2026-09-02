import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getTimeExpenseData } from "@/lib/time-expense-actions";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { resolveProjectPhaseCodes } from "@/lib/project-phases";
import { prismaPhaseDataSource } from "@/lib/project-phases-db";
import TimeExpensesClient from "./TimeExpensesClient";

export default async function TimeExpensesPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id: projectId } = await params;
    const session = await getServerSession(authOptions);

    if (!session?.user?.email) redirect("/login");

    const user = await prisma.user.findUnique({
        where: { email: session.user.email },
    });

    if (!user) redirect("/login");

    if (user.role !== "ADMIN" && user.role !== "MANAGER") {
        const permission = await prisma.userPermission.findUnique({
            where: { userId: user.id },
        });
        if (!permission?.timeClock) {
            redirect(`/projects/${projectId}`);
        }
    }

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true },
    });

    if (!project) redirect("/projects");

    // The Tax & phase panel edits numbers that land on a state excise return,
    // so it is gated on `financialReports` — not on the `timeClock` permission
    // that merely gets you onto this page — and it may only offer THIS
    // project's phases.
    const [data, companyTimeZone, permissionedUser, phases] = await Promise.all([
        getTimeExpenseData(projectId),
        resolveCompanyTimeZone(),
        getCurrentUserWithPermissions(),
        resolveProjectPhaseCodes(prismaPhaseDataSource, projectId),
    ]);
    const canEditTax = !!permissionedUser && hasPermission(permissionedUser, "financialReports");

    return (
        <div className="flex h-full bg-hui-background">
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-7xl mx-auto space-y-6">
                    <TimeExpensesClient
                        project={project}
                        data={JSON.parse(JSON.stringify(data))}
                        currentUser={{ id: user.id, role: user.role, name: user.name || user.email }}
                        companyTimeZone={companyTimeZone}
                        phases={phases.map(p => ({ id: p.id, code: p.code, name: p.name }))}
                        canEditTax={canEditTax}
                    />
                </div>
            </div>
        </div>
    );
}
