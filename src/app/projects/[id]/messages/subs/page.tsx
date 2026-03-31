import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import SubMessagesClient from "./SubMessagesClient";

export default async function SubMessagesPage({ params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) redirect("/login");

    const { id: projectId } = await params;

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, client: { select: { name: true } } },
    });

    if (!project) {
        return <div className="p-8 text-center text-hui-textMuted">Project not found.</div>;
    }

    const subcontractors = await prisma.subcontractor.findMany({
        where: { status: "ACTIVE" },
        select: { id: true, companyName: true, contactName: true },
        orderBy: { companyName: "asc" },
    });

    return (
        <SubMessagesClient
            projectId={project.id}
            projectName={project.name}
            subcontractors={subcontractors}
            currentUserName={session.user.name || session.user.email || "Team"}
            currentUserEmail={session.user.email || undefined}
        />
    );
}
