import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import CrewAssignment from "./CrewAssignment";
import PortalVisibilityToggles from "./PortalVisibilityToggles";
import { getPortalVisibility } from "@/lib/actions";

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
            crew: true
        }
    });

    if (!project) return <div>Project not found</div>;

    const allEmployees = await prisma.user.findMany({
        where: { role: 'EMPLOYEE' }
    });

    const visibility = await getPortalVisibility(projectId);

    return (
        <div className="max-w-4xl mx-auto py-8 px-6 space-y-8">
            <h1 className="text-3xl font-bold mb-8 text-hui-textMain">Project Settings: {project.name}</h1>

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

            {/* Client Portal Visibility Section */}
            <div className="hui-card p-8">
                <div className="mb-6">
                    <h2 className="text-xl font-semibold text-hui-textMain flex items-center gap-2">
                        <svg className="w-5 h-5 text-hui-textMuted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        Client Portal Visibility
                    </h2>
                    <p className="text-hui-textMuted text-sm mt-1">
                        Control which sections your client can see when they log into the portal for this project.
                    </p>
                </div>

                <PortalVisibilityToggles
                    projectId={project.id}
                    initialState={{
                        showSchedule: visibility.showSchedule,
                        showFiles: visibility.showFiles,
                        showDailyLogs: visibility.showDailyLogs,
                        showEstimates: visibility.showEstimates,
                        showInvoices: visibility.showInvoices,
                        showContracts: visibility.showContracts,
                        showMessages: visibility.showMessages,
                    }}
                />
            </div>
        </div>
    );
}
