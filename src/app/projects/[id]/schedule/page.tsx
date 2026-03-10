import { getProject, getScheduleTasks } from "@/lib/actions";
import GanttChart from "./GanttChart";

export const dynamic = "force-dynamic";

export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return <div className="p-6 text-hui-textMuted">Project not found</div>;

    const rawTasks = await getScheduleTasks(id);

    // Map tasks with dependency + time entry data for the client component
    const tasks = rawTasks.map((t: any) => ({
        id: t.id,
        name: t.name,
        startDate: t.startDate.toISOString().split("T")[0],
        endDate: t.endDate.toISOString().split("T")[0],
        color: t.color,
        progress: t.progress,
        status: t.status,
        assignee: t.assignee,
        order: t.order,
        estimatedHours: t.estimatedHours ?? null,
        actualHours: (t.timeEntries || []).reduce((sum: number, te: any) => sum + (te.durationHours || 0), 0),
        dependencies: (t.dependencies || []).map((d: any) => ({
            id: d.id,
            predecessorId: d.predecessorId,
            dependentId: d.dependentId,
        })),
        dependents: (t.dependents || []).map((d: any) => ({
            id: d.id,
            predecessorId: d.predecessorId,
            dependentId: d.dependentId,
        })),
    }));

    // Pass estimate summaries for the import dropdown
    const estimates = (project.estimates || []).map((e: any) => ({
        id: e.id,
        title: e.title,
        status: e.status,
    }));

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            <GanttChart
                projectId={id}
                projectName={project.name}
                initialTasks={tasks}
                estimates={estimates}
            />
        </div>
    );
}
