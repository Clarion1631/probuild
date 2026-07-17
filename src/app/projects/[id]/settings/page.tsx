import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import CrewAssignment from "./CrewAssignment";
import ManagerAssignRow from "@/components/ManagerAssignRow";

export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) return redirect("/login");

    const resolvedParams = await params;
    const projectId = resolvedParams.id;

    // Auth check
    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
            crew: true,
            manager: true,
        }
    });

    if (!project) return <div>Project not found</div>;

    const allEmployees = await prisma.user.findMany({
        where: { status: 'ACTIVATED' },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });



    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-8">
            <h1 className="text-3xl font-bold mb-8 text-hui-textMain">Project Settings: {project.name}</h1>

            {/* Manager Assignment Section */}
            <div className="hui-card p-8">
                <h2 className="text-xl font-semibold mb-2 text-hui-textMain">Project Manager</h2>
                <p className="text-hui-textMuted text-sm mb-6">Assign the manager responsible for this project.</p>
                <ManagerAssignRow
                    entityType="project"
                    entityId={project.id}
                    currentManagerId={(project as any).manager?.id || null}
                    currentManagerName={(project as any).manager?.name || null}
                />
            </div>

            {/* Crew Assignment Section */}
            <div className="hui-card p-8">
                <h2 className="text-xl font-semibold mb-2 text-hui-textMain">Assign Crew</h2>
                <p className="text-hui-textMuted text-sm mb-6">Select which employees should be able to clock time against this project.</p>

                <CrewAssignment
                    projectId={project.id}
                    currentCrew={project.crew}
                    allEmployees={allEmployees}
                />
            </div>

        </div>
    );
}
