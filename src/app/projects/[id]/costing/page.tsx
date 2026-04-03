import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import JobCostingClient from "./JobCostingClient";

export default async function JobCostingPage({
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

    // Check permissions
    if (user.role !== "ADMIN" && user.role !== "MANAGER") {
        const permission = await prisma.userPermission.findUnique({
            where: { userId: user.id }
        });
        if (!permission?.financialReports) {
            redirect(`/projects/${projectId}`);
        }
    }

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true }
    });

    if (!project) redirect("/projects");

    // Fetch budget (from estimates) - find active or approved estimates
    const estimates = await prisma.estimate.findMany({
        where: { projectId },
        include: {
            items: {
                include: {
                    costCode: true,
                    costType: true,
                }
            }
        }
    });

    // Fetch Actuals: Time Entries and Expenses
    const timeEntries = await prisma.timeEntry.findMany({
        where: { projectId },
        include: { costCode: true }
    });

    const expenses = await prisma.expense.findMany({
        where: {
            estimate: {
                projectId: projectId
            }
        },
        include: { costCode: true }
    });

    // Fetch Purchase Orders for "Committed Costs"
    const purchaseOrders = await prisma.purchaseOrder.findMany({
        where: { projectId },
        include: {
            items: { include: { costCode: true } }
        }
    });

    // We'll process the numbers on the client or server. Let's send raw to client for easy filtering if needed, 
    // or aggregate here. We'll aggregate on the client for flexibility.

    return (
        <JobCostingClient 
            project={project}
            estimates={estimates}
            timeEntries={timeEntries}
            expenses={expenses}
            purchaseOrders={purchaseOrders}
        />
    );
}
