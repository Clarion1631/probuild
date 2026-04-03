import { getProject, getScheduleTasks, getTeamMembers, getActiveSubcontractors } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
import GanttChart from "./GanttChart";

export const dynamic = "force-dynamic";

export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const [project, rawTasks, teamMembers, subcontractors, session] = await Promise.all([
        getProject(id),
        getScheduleTasks(id),
        getTeamMembers(),
        getActiveSubcontractors(),
        getSessionOrDev(),
    ]);
    if (!project) return <div className="p-6 text-hui-textMuted">Project not found</div>;

    const currentUserId = (session?.user as any)?.id || "system";

    const tasks = rawTasks.map((t: any) => ({
        id: t.id,
        name: t.name,
        startDate: t.startDate.toISOString().split("T")[0],
        endDate: t.endDate.toISOString().split("T")[0],
        color: t.color,
        progress: t.progress,
        status: t.status,
        type: t.type || "task",
        assignee: t.assignee,
        order: t.order,
        estimatedHours: t.estimatedHours ?? null,
        actualHours: (t.timeEntries || []).reduce((sum: number, te: any) => sum + (te.durationHours || 0), 0),
        dependencies: (t.dependencies || []).map((d: any) => ({ id: d.id, predecessorId: d.predecessorId, dependentId: d.dependentId })),
        dependents: (t.dependents || []).map((d: any) => ({ id: d.id, predecessorId: d.predecessorId, dependentId: d.dependentId })),
        assignments: (t.assignments || []).map((a: any) => ({ id: a.id, userId: a.userId, user: a.user })),
        subAssignments: (t.subAssignments || []).map((a: any) => ({ id: a.id, subcontractorId: a.subcontractorId, subcontractor: a.subcontractor })),
        estimateItemId: t.estimateItemId ?? null,
        estimateItem: t.estimateItem ?? null,
    }));

    const estimates = (project.estimates || []).map((e: any) => ({ id: e.id, title: e.title, status: e.status }));

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            <GanttChart
                projectId={id}
                projectName={project.name}
                initialTasks={tasks}
                estimates={estimates}
                teamMembers={teamMembers as any}
                subcontractors={subcontractors as any}
                currentUserId={currentUserId}
            />
        </div>
    );
}
