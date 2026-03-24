import { prisma } from "@/lib/prisma";
import TakeoffsClient from "./TakeoffsClient";

export default async function ProjectTakeoffsPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;

    const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, type: true, location: true },
    });

    if (!project) {
        return (
            <div className="flex items-center justify-center h-64 text-hui-textMuted">
                Project not found.
            </div>
        );
    }

    return (
        <TakeoffsClient
            contextType="project"
            contextId={project.id}
            contextName={project.name}
        />
    );
}
