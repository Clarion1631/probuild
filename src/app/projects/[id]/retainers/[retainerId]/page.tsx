import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import RetainerEditor from "./RetainerEditor";

export default async function RetainerDetailPage({ params }: { params: Promise<{ id: string; retainerId: string }> }) {
    const { id: projectId, retainerId } = await params;

    const retainer = await prisma.retainer.findUnique({
        where: { id: retainerId },
    });

    if (!retainer || retainer.projectId !== projectId) notFound();

    const serialized = {
        id: retainer.id,
        code: retainer.code,
        status: retainer.status,
        totalAmount: Number(retainer.totalAmount),
        balanceDue: Number(retainer.balanceDue),
        amountPaid: Number(retainer.amountPaid),
        notes: retainer.notes,
        dueDate: retainer.dueDate ? retainer.dueDate.toISOString().split("T")[0] : null,
        issueDate: retainer.issueDate ? retainer.issueDate.toISOString().split("T")[0] : null,
        createdAt: retainer.createdAt.toISOString(),
    };

    return <RetainerEditor retainer={serialized} projectId={projectId} />;
}
