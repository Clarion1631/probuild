import { redirect, notFound } from "next/navigation";
import { getSubPortalSession } from "@/lib/sub-portal-auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import ProjectViewTracker from "@/components/ProjectViewTracker";

export default async function SubPortalProjectDetail(props: { params: Promise<{ id: string }> }) {
    const sub = await getSubPortalSession();
    if (!sub) redirect("/sub-portal/login");

    const params = await props.params;
    const projectId = params.id;

    const access = await prisma.subcontractorProjectAccess.findUnique({
        where: { subcontractorId_projectId: { subcontractorId: sub.id, projectId } },
        include: { project: true }
    });

    if (!access) return notFound();

    const project = access.project;

    // Fetch POs related to this Subcontractor (linked by Vendor email)
    const vendor = await prisma.vendor.findFirst({ where: { email: sub.email } });
    const purchaseOrders = vendor ? await prisma.purchaseOrder.findMany({
        where: { projectId, vendorId: vendor.id, status: { not: "Draft" } },
        include: { files: true },
        orderBy: { createdAt: "desc" }
    }) : [];

    // Fetch tasks assigned to this subcontractor in this project
    const assignments = await prisma.subTaskAssignment.findMany({
        where: {
            subcontractorId: sub.id,
            task: { projectId },
        },
        include: {
            task: true,
        },
        orderBy: { task: { startDate: "asc" } },
    });

    const tasks = assignments.map((a) => a.task);

    // Calculate progress stats
    const completed = tasks.filter((t) => t.status === "Completed").length;
    const inProgress = tasks.filter((t) => t.status === "In Progress").length;
    const notStarted = tasks.filter((t) => t.status === "Not Started").length;
    const overallProgress = tasks.length > 0 ? Math.round(tasks.reduce((sum, t) => sum + t.progress, 0) / tasks.length) : 0;

    function getStatusColor(status: string) {
        switch (status) {
            case "Completed": return "bg-emerald-100 text-emerald-700";
            case "In Progress": return "bg-blue-100 text-blue-700";
            case "Not Started": return "bg-slate-100 text-slate-600";
            case "Delayed": return "bg-red-100 text-red-700";
            default: return "bg-slate-100 text-slate-600";
        }
    }

    function getProgressBarColor(progress: number) {
        if (progress >= 100) return "bg-emerald-500";
        if (progress >= 50) return "bg-blue-500";
        if (progress > 0) return "bg-amber-500";
        return "bg-slate-300";
    }

    return (
        <div className="max-w-5xl mx-auto py-8">
            <ProjectViewTracker projectId={projectId} subcontractorId={sub.id} />
            {/* Back Button */}
            <div className="mb-6">
                <Link
                    href="/sub-portal"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back to Dashboard
                </Link>
            </div>

            {/* Project Header */}
            <div className="hui-card p-8 mb-8">
                <div className="flex justify-between items-start">
                    <div>
                        <h1 className="text-3xl font-bold text-hui-textMain mb-2">{project.name}</h1>
                        <div className="flex gap-4 text-sm text-hui-textMuted">
                            {project.location && <span>{project.location}</span>}
                            <span>•</span>
                            <span>Started {new Date(project.createdAt).toLocaleDateString()}</span>
                        </div>
                    </div>
                    <div className="flex flex-col items-end gap-3">
                        <span className={`text-xs px-3 py-1 rounded-full font-semibold ${
                            project.status === "Completed" ? "bg-emerald-100 text-emerald-700" :
                            project.status === "In Progress" ? "bg-blue-100 text-blue-700" :
                            "bg-slate-100 text-slate-600"
                        }`}>
                            {project.status}
                        </span>
                        <Link 
                            href={`/sub-portal/projects/${projectId}/messages`}
                            className="hui-btn hui-btn-secondary text-sm"
                        >
                            <svg className="w-4 h-4 mr-2 text-hui-textMuted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                            Messages
                        </Link>
                    </div>
                </div>
            </div>

            {/* Progress Overview */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
                <div className="hui-card p-5 text-center">
                    <p className="text-3xl font-bold text-hui-textMain">{overallProgress}%</p>
                    <p className="text-xs text-hui-textMuted font-medium mt-1">Overall Progress</p>
                    <div className="w-full bg-slate-200 rounded-full h-2 mt-3">
                        <div className={`h-2 rounded-full transition-all duration-500 ${getProgressBarColor(overallProgress)}`}
                            style={{ width: `${overallProgress}%` }} />
                    </div>
                </div>
                <div className="hui-card p-5 text-center">
                    <p className="text-3xl font-bold text-emerald-600">{completed}</p>
                    <p className="text-xs text-hui-textMuted font-medium mt-1">Completed</p>
                </div>
                <div className="hui-card p-5 text-center">
                    <p className="text-3xl font-bold text-blue-600">{inProgress}</p>
                    <p className="text-xs text-hui-textMuted font-medium mt-1">In Progress</p>
                </div>
                <div className="hui-card p-5 text-center">
                    <p className="text-3xl font-bold text-slate-500">{notStarted}</p>
                    <p className="text-xs text-hui-textMuted font-medium mt-1">Not Started</p>
                </div>
            </div>

            {/* Task List */}
            <h2 className="text-lg font-bold text-hui-textMain mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-hui-textMuted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                Your Assigned Tasks ({tasks.length})
            </h2>

            <div className="hui-card overflow-hidden">
                {/* Table Header */}
                <div className="grid grid-cols-12 gap-4 px-6 py-3 bg-slate-50/80 border-b border-hui-border text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                    <div className="col-span-4">Task</div>
                    <div className="col-span-2 text-center">Status</div>
                    <div className="col-span-2 text-center">Start</div>
                    <div className="col-span-2 text-center">End</div>
                    <div className="col-span-2 text-center">Progress</div>
                </div>

                {/* Task Rows */}
                {tasks.map((task, idx) => {
                    const start = new Date(task.startDate);
                    const end = new Date(task.endDate);
                    const now = new Date();
                    const isOverdue = now > end && task.status !== "Completed";

                    return (
                        <div
                            key={task.id}
                            className={`grid grid-cols-12 gap-4 px-6 py-4 items-center transition hover:bg-slate-50/50 ${
                                idx !== tasks.length - 1 ? "border-b border-hui-border" : ""
                            }`}
                        >
                            {/* Task Name */}
                            <div className="col-span-4">
                                <p className="text-sm font-semibold text-hui-textMain">{task.name}</p>
                                {isOverdue && (
                                    <p className="text-[10px] text-red-500 font-medium mt-0.5 flex items-center gap-1">
                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.834-2.694-.834-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                                        Overdue
                                    </p>
                                )}
                            </div>

                            {/* Status */}
                            <div className="col-span-2 flex justify-center">
                                <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider whitespace-nowrap ${getStatusColor(task.status)}`}>
                                    {task.status}
                                </span>
                            </div>

                            {/* Start Date */}
                            <div className="col-span-2 text-center text-sm text-hui-textMuted">
                                {start.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                            </div>

                            {/* End Date */}
                            <div className="col-span-2 text-center text-sm text-hui-textMuted">
                                {end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                            </div>

                            {/* Progress */}
                            <div className="col-span-2">
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 bg-slate-200 rounded-full h-2">
                                        <div
                                            className={`h-2 rounded-full transition-all duration-300 ${getProgressBarColor(task.progress)}`}
                                            style={{ width: `${task.progress}%` }}
                                        />
                                    </div>
                                    <span className="text-xs font-medium text-hui-textMuted w-8 text-right">{task.progress}%</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Purchase Orders */}
            {purchaseOrders.length > 0 && (
                <div className="mt-12">
                    <h2 className="text-lg font-bold text-hui-textMain mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-hui-textMuted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Purchase Orders & Files ({purchaseOrders.length})
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {purchaseOrders.map((po) => (
                            <div key={po.id} className="hui-card p-6 flex flex-col h-full border border-hui-border hover:border-slate-300 transition">
                                <div className="flex justify-between items-start mb-4">
                                    <div>
                                        <p className="font-bold text-hui-textMain flex items-center gap-2">
                                            {po.code} 
                                        </p>
                                        <p className="text-xs text-hui-textMuted mt-1">Issued: {new Date(po.createdAt).toLocaleDateString()}</p>
                                    </div>
                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-blue-100 text-blue-700">
                                        {po.status}
                                    </span>
                                </div>
                                <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 mb-4 whitespace-pre-wrap text-sm text-slate-600 font-sans">
                                    {po.terms || po.notes || "No additional terms provided."}
                                </div>
                                <div className="mt-auto">
                                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-3">Attachments</p>
                                    {!po.files || po.files.length === 0 ? (
                                        <p className="text-sm text-slate-400 italic">No files attached.</p>
                                    ) : (
                                        <ul className="space-y-2">
                                            {po.files.map((file: any) => (
                                                <li key={file.id}>
                                                    <a href={file.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 p-2 rounded-lg bg-blue-50/50 hover:bg-blue-50 text-blue-700 transition border border-blue-100/50">
                                                        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                                        </svg>
                                                        <span className="text-sm font-medium truncate">{file.name}</span>
                                                    </a>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
