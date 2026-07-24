import { getProject, getScheduleTasks, getTeamMembers, getActiveSubcontractors, getPortalVisibility } from "@/lib/actions";
import ScheduleView from "./ScheduleView";

export const dynamic = "force-dynamic";

export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const [project, rawTasks, teamMembers, subcontractors, portalVisibility] = await Promise.all([
        getProject(id),
        getScheduleTasks(id),
        getTeamMembers(),
        getActiveSubcontractors(),
        getPortalVisibility(id),
    ]);
    if (!project) return <div className="p-6 text-hui-textMuted">Project not found</div>;

    const tasks = rawTasks.map((t: any) => ({
        id: t.id,
        projectId: t.projectId,
        name: t.name,
        startDate: t.startDate.toISOString().split("T")[0],
        endDate: t.endDate.toISOString().split("T")[0],
        color: t.color,
        progress: t.progress,
        status: t.status,
        type: t.type || "task",
        assignee: t.assignee,
        parentId: t.parentId,
        order: t.order,
        estimatedHours: t.estimatedHours ?? null,
        doneWhen: t.doneWhen ?? null,
        blockedReason: t.blockedReason ?? null,
        scheduledTime: t.scheduledTime ?? null,
        confirmationStatus: t.confirmationStatus ?? null,
        actualHours: (t.timeEntries || []).reduce((sum: number, te: any) => sum + (te.durationHours || 0), 0),
        dependencies: (t.dependencies || []).map((d: any) => ({ id: d.id, predecessorId: d.predecessorId, dependentId: d.dependentId })),
        dependents: (t.dependents || []).map((d: any) => ({ id: d.id, predecessorId: d.predecessorId, dependentId: d.dependentId })),
        assignments: (t.assignments || []).map((a: any) => ({ id: a.id, userId: a.userId, role: a.role, user: a.user })),
        subAssignments: (t.subAssignments || []).map((a: any) => ({ id: a.id, subcontractorId: a.subcontractorId, subcontractor: a.subcontractor })),
        estimateItemId: t.estimateItemId ?? null,
        estimateItem: t.estimateItem ? { ...t.estimateItem, total: Number(t.estimateItem.total) } : null,
        baselineStartDate: t.baselineStartDate?.toISOString().split("T")[0] ?? null,
        baselineEndDate: t.baselineEndDate?.toISOString().split("T")[0] ?? null,
    }));

    const estimates = (project.estimates || []).map((e: any) => ({ id: e.id, title: e.title, status: e.status }));

    return (
        <div className="flex flex-col h-[calc(100%+48px)] -m-6 overflow-hidden bg-hui-background">
            <ScheduleView
                projectId={id}
                projectName={project.name}
                initialTasks={tasks}
                estimates={estimates}
                teamMembers={teamMembers as any}
                subcontractors={subcontractors as any}
                initialPublished={portalVisibility.showSchedule}
            />
        </div>
    );
}
