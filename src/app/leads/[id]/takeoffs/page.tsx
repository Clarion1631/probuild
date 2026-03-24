import { prisma } from "@/lib/prisma";
import TakeoffsClient from "@/app/projects/[id]/takeoffs/TakeoffsClient";

export default async function LeadTakeoffsPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;

    const lead = await prisma.lead.findUnique({
        where: { id },
        select: { id: true, name: true, projectType: true, location: true },
    });

    if (!lead) {
        return (
            <div className="flex items-center justify-center h-64 text-hui-textMuted">
                Lead not found.
            </div>
        );
    }

    return (
        <TakeoffsClient
            contextType="lead"
            contextId={lead.id}
            contextName={lead.name}
        />
    );
}
