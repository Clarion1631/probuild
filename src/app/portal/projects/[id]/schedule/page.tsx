import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getPortalVisibility, getScheduleTasks } from "@/lib/actions";
import PortalGanttChart from "./PortalGanttChart";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function PortalSchedulePage(props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    const { id } = params;
    
    const visibility = await getPortalVisibility(id);
    if (!visibility.isPortalEnabled || !visibility.showSchedule) {
        return notFound();
    }

    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return notFound();

    const rawTasks = await getScheduleTasks(id);

    const tasks = rawTasks.map((t: any) => ({
        id: t.id,
        name: t.name,
        startDate: t.startDate.toISOString().split("T")[0],
        endDate: t.endDate.toISOString().split("T")[0],
        color: t.color,
        progress: t.progress,
        status: t.status,
        type: t.type || "task",
        order: t.order,
        dependencies: (t.dependencies || []).map((d: any) => ({ 
            id: d.id, 
            predecessorId: d.predecessorId, 
            dependentId: d.dependentId 
        })),
        assignments: (t.assignments || []).map((a: any) => ({ 
            id: a.id, 
            userId: a.userId, 
            user: { name: a.user.name, email: a.user.email } 
        })),
    }));

    return (
        <div className="max-w-[1400px] mx-auto py-8 px-4">
            <div className="mb-6 flex items-center justify-between">
                <Link href={`/portal/projects/${id}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition shadow-sm w-fit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back to Project
                </Link>
                <div className="text-right">
                    <h1 className="text-2xl font-bold text-slate-800">Project Schedule</h1>
                    <p className="text-sm text-slate-500">{project.name}</p>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col min-h-[600px] max-h-[75vh] overflow-hidden">
                <PortalGanttChart initialTasks={tasks} />
            </div>
        </div>
    );
}
