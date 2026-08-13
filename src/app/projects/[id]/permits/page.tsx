import { getPermits } from "@/lib/actions";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import PermitsClient from "./PermitsClient";

export default async function PermitsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true },
    });

    if (!project) notFound();

    const permits = await getPermits(id);

    return (
        <PermitsClient
            projectId={id}
            projectName={project.name}
            initialPermits={JSON.parse(JSON.stringify(permits))}
        />
    );
}
