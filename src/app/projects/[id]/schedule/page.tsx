import { getProject, getScheduleTasks, getTeamMembers, getActiveSubcontractors, getPortalVisibility } from "@/lib/actions";
import { getSessionOrDev } from "@/lib/auth";
import GanttChart from "./GanttChart";
import SchedulePublishButton from "./SchedulePublishButton";

export const dynamic = "force-dynamic";

export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const [project, rawTasks, teamMembers, subcontractors, session, portalVisibility] = await Promise.all([
        getProject(id),
        getScheduleTasks(id),
        getTeamMembers(),
        getActiveSubcontractors(),
        getSessionOrDev(),
        getPortalVisibility(id),
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
        estimateItem: t.estimateItem ? { ...t.estimateItem, total: Number(t.estimateItem.total) } : null,
        baselineStartDate: null,
        baselineEndDate: null,
    }));

    const estimates = (project.estimates || []).map((e: any) => ({ id: e.id, title: e.title, status: e.status }));

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            <div className="flex items-center justify-between px-4 py-2 border-b border-hui-border bg-white">
                <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-hui-textMain">Schedule</h2>
                    <span className="text-xs text-hui-textMuted">({tasks.length} tasks)</span>
                </div>
                <SchedulePublishButton
                    projectId={id}
                    initialPublished={portalVisibility.showSchedule}
                />
            </div>
            <div className="flex-1 overflow-hidden">
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
        </div>
    );
}
