import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import PurchaseOrderEditor from "./PurchaseOrderEditor";

export default async function PurchaseOrderDetailPage({
    params,
}: {
    params: Promise<{ id: string; poId: string }>;
}) {
    const { id: projectId, poId } = await params;
    
    // Auth Check
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) redirect("/login");

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true }
    });
    if (!project) redirect("/projects");

    const vendors = await prisma.vendor.findMany({ orderBy: { name: 'asc' } });
    const costCodes = await prisma.costCode.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } });

    let initialData = null;

    if (poId && poId !== "new") {
        const po = await prisma.purchaseOrder.findUnique({
            where: { id: poId },
            include: {
                vendor: true,
                files: true,
                messages: {
                    orderBy: { createdAt: "asc" }
                },
                items: {
                    orderBy: { order: "asc" },
                    include: { costCode: true }
                }
            }
        });

        if (!po) redirect(`/projects/${projectId}/purchase-orders`);
        initialData = po;
    }

    return (
        <PurchaseOrderEditor 
            context={{
                projectId,
                projectName: project.name,
                vendors,
                costCodes
            }}
            initialData={initialData}
        />
    );
}
