import { getAllScheduleTasks, getTeamMembers } from "@/lib/actions";
import MasterGantt from "./MasterGantt";

export const dynamic = "force-dynamic";

export default async function MasterSchedulePage() {
    const [rawTasks, teamMembers] = await Promise.all([
        getAllScheduleTasks(),
        getTeamMembers(),
    ]);

    // Group tasks by project
    const tasks = rawTasks.map((t: any) => ({
        id: t.id,
        name: t.name,
        startDate: t.startDate.toISOString().split("T")[0],
        endDate: t.endDate.toISOString().split("T")[0],
        color: t.color,
        progress: t.progress,
        status: t.status,
        order: t.order,
        estimatedHours: t.estimatedHours ?? null,
        actualHours: (t.timeEntries || []).reduce((sum: number, te: any) => sum + (te.durationHours || 0), 0),
        projectId: t.projectId,
        projectName: t.project.name,
        projectType: t.project.type,
        assignments: (t.assignments || []).map((a: any) => ({
            userId: a.userId,
            userName: a.user.name || a.user.email,
            userEmail: a.user.email,
        })),
    }));

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            <MasterGantt initialTasks={tasks} teamMembers={teamMembers as any} />
        </div>
    );
}
