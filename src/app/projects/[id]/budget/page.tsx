import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getBudgetData } from "@/lib/actions";
import BudgetClient from "./BudgetClient";

export default async function BudgetPage({
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
        if (!permission?.financialReports) {
            redirect(`/projects/${projectId}`);
        }
    }

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true },
    });

    if (!project) redirect("/projects");

    const budgetData = await getBudgetData(projectId);

    return (
        <div className="flex h-full bg-hui-background">
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-7xl mx-auto space-y-6">
                    <BudgetClient project={project} data={budgetData} />
                </div>
            </div>
        </div>
    );
}
