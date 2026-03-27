import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import ProjectChat from "@/components/ProjectChat";

export default async function ProjectMessagesPage({ params }: { params: Promise<{ id: string }> }) {
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

    return (
        <div className="max-w-3xl mx-auto py-6 px-4">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-hui-textMain">Messages</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Conversation with <span className="font-medium">{project.client.name}</span> for <span className="font-medium">{project.name}</span>
                </p>
            </div>

            <ProjectChat
                projectId={projectId}
                perspective="TEAM"
                currentUserName={session.user.name || session.user.email || "Team"}
                currentUserEmail={session.user.email || undefined}
            />
        </div>
    );
}
