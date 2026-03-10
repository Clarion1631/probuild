import { getProject, getScheduleTasks } from "@/lib/actions";
import GanttChart from "./GanttChart";

export const dynamic = "force-dynamic";

export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return <div className="p-6 text-hui-textMuted">Project not found</div>;

    const tasks = await getScheduleTasks(id);

    // Pass estimate summaries for the import dropdown
    const estimates = (project.estimates || []).map((e: any) => ({
        id: e.id,
        title: e.title,
        status: e.status,
        itemCount: 0, // will be enriched client-side if needed
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
