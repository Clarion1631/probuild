import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import ClientMessaging from "@/components/ClientMessaging";

export default async function ProjectMessagesPage({ params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) redirect("/login");

    const { id: projectId } = await params;

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            name: true,
            client: { select: { id: true, name: true, email: true, primaryPhone: true } },
            estimates: { select: { id: true, code: true, title: true, status: true } },
        },
    });

    if (!project) {
        return <div className="p-8 text-center text-hui-textMuted">Project not found.</div>;
    }

    return (
        <div className="max-w-3xl mx-auto py-6 px-4">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-hui-textMain">Client Messages</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Conversation with <span className="font-medium">{project.client.name}</span> for <span className="font-medium">{project.name}</span>
                </p>
            </div>

            <div className="bg-white border border-hui-border rounded-xl overflow-hidden flex flex-col min-h-0" style={{ height: "calc(100svh - 240px)", minHeight: "300px" }}>
                <ClientMessaging
                    entityId={projectId}
                    entityType="project"
                    clientId={project.client.id}
                    clientName={project.client.name}
                    clientEmail={project.client.email}
                    clientPhone={project.client.primaryPhone}
                    estimates={project.estimates}
                    variant="full"
                />
            </div>
        </div>
    );
}
