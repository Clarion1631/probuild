import { getProject, getScheduleTasks, getPortalVisibility } from "@/lib/actions";
import { getProjectSubcontractors } from "@/lib/subcontractor-actions";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound } from "next/navigation";
import ProjectHeader from "./ProjectHeader";
import ProjectDashboardsWidget from "@/components/ProjectDashboardsWidget";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

function timeAgo(d: Date, now: number) {
    const sec = Math.floor((now - d.getTime()) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fileExt(name: string) {
    const m = name.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toUpperCase() : "FILE";
}

export default async function ProjectDashboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) notFound();

    const [tasks, portalVisibility, subList, recentActivity, recentFiles] = await Promise.all([
        getScheduleTasks(id),
        getPortalVisibility(id),
        getProjectSubcontractors(id),
        Promise.all([
            prisma.dailyLog.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, date: true, workPerformed: true, createdAt: true } }),
            prisma.changeOrder.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, title: true, status: true, createdAt: true } }),
            prisma.invoice.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, code: true, status: true, totalAmount: true, createdAt: true } }),
        ]).then(([logs, cos, invs]) => [
            ...logs.map(l => ({ type: "dailylog" as const, id: l.id, label: `Daily log · ${new Date(l.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, sub: l.workPerformed.slice(0, 60), date: new Date(l.createdAt), href: `/projects/${id}/dailylogs` })),
            ...cos.map(c => ({ type: "changeorder" as const, id: c.id, label: `Change order · ${c.title}`, sub: c.status, date: new Date(c.createdAt), href: `/projects/${id}/change-orders/${c.id}` })),
            ...invs.map(i => ({ type: "invoice" as const, id: i.id, label: `Invoice ${i.code}`, sub: `${i.status} · ${formatCurrency(Number(i.totalAmount))}`, date: new Date(i.createdAt), href: `/projects/${id}/invoices/${i.id}` })),
        ].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 10)),
        prisma.projectFile.findMany({
            where: { projectId: id },
            orderBy: { createdAt: "desc" },
            take: 8,
            select: { id: true, name: true, url: true, mimeType: true, size: true, createdAt: true },
        }),
    ]);
    const estimates = project.estimates || [];

    // Real stats
    const totalBudget = estimates.reduce((sum: number, e: any) => sum + Number(e.totalAmount || 0), 0);
    const completedTasks = tasks.filter((t: any) => t.status === "Complete").length;
    const inProgressTasks = tasks.filter((t: any) => t.status === "In Progress").length;
    const taskProgress = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0;

    // Upcoming tasks (not completed, sorted by end date)
    const upcoming = tasks
        .filter((t: any) => t.status !== "Complete")
        .sort((a: any, b: any) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())
        .slice(0, 5);

    const today = new Date();
    const now = Date.now();

    return (
        <div className="max-w-7xl mx-auto">
            <ProjectHeader
                projectId={id}
                name={project.name}
                clientName={project.client?.name || "No client"}
                location={project.location}
                status={project.status}
            />

            {/* Stats Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-8">
                <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">
                    <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-400 to-blue-500" />
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-1.5">Budget</p>
                    <p className="text-2xl font-bold text-hui-textMain">{formatCurrency(totalBudget)}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{estimates.length} estimate{estimates.length !== 1 ? 's' : ''}</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">
                    <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-green-400 to-emerald-500" />
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-1.5">Schedule</p>
                    <div className="flex items-end gap-2">
                        <p className="text-2xl font-bold text-hui-textMain">{taskProgress}%</p>
                        <div className="flex-1 mb-2">
                            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-gradient-to-r from-green-400 to-emerald-500 rounded-full transition-all" style={{ width: `${taskProgress}%` }} />
                            </div>
                        </div>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1">{completedTasks}/{tasks.length} tasks done</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">
                    <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-400 to-orange-500" />
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-1.5">In Progress</p>
                    <p className="text-2xl font-bold text-amber-600">{inProgressTasks}</p>
                    <p className="text-[10px] text-slate-400 mt-1">Active tasks right now</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">
                    <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-purple-400 to-violet-500" />
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-1.5">Estimates</p>
                    <p className="text-2xl font-bold text-purple-600">{estimates.length}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{estimates.filter((e: any) => e.status === 'Approved').length} approved</p>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Recent Activity — prominent left column */}
                <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 bg-gradient-to-br from-emerald-100 to-green-100 rounded-lg flex items-center justify-center">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                            </div>
                            <h2 className="text-sm font-bold text-hui-textMain">Recent Activity</h2>
                            <span className="text-[10px] text-slate-400 font-medium bg-slate-100 px-2 py-0.5 rounded-full">{recentActivity.length}</span>
                        </div>
                    </div>
                    <div className="divide-y divide-slate-100">
                        {recentActivity.length === 0 && (
                            <div className="px-6 py-10 text-center">
                                <p className="text-sm text-slate-400">No activity yet</p>
                                <p className="text-xs text-slate-400 mt-1">Daily logs, change orders, and invoices will appear here.</p>
                            </div>
                        )}
                        {recentActivity.map(event => {
                            const iconColor = event.type === "dailylog" ? "#22c55e" : event.type === "changeorder" ? "#f59e0b" : "#6366f1";
                            const iconPath = event.type === "dailylog"
                                ? "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                : event.type === "changeorder"
                                ? "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                : "M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6";
                            return (
                                <Link key={`${event.type}-${event.id}`} href={event.href} className="px-6 py-4 flex items-start gap-3 hover:bg-slate-50/50 transition">
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5" style={{ backgroundColor: `${iconColor}18` }}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="1.5">
                                            <path strokeLinecap="round" strokeLinejoin="round" d={iconPath} />
                                        </svg>
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-hui-textMain truncate">{event.label}</p>
                                        <p className="text-xs text-slate-400 truncate">{event.sub}</p>
                                    </div>
                                    <span className="text-[11px] text-slate-400 shrink-0 font-medium">{timeAgo(event.date, now)}</span>
                                </Link>
                            );
                        })}
                    </div>
                </div>

                {/* Right rail */}
                <div className="space-y-5">
                    {/* Upcoming Tasks — compact */}
                    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
                        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Upcoming Tasks</h3>
                                <span className="text-[10px] text-slate-400 font-medium bg-slate-100 px-1.5 py-0.5 rounded-full">{upcoming.length}</span>
                            </div>
                            <Link href={`/projects/${id}/schedule`} className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 transition">
                                View →
                            </Link>
                        </div>
                        <div className="divide-y divide-slate-100">
                            {upcoming.length === 0 && (
                                <div className="px-4 py-6 text-center">
                                    <p className="text-xs text-slate-400">No upcoming tasks</p>
                                    <Link href={`/projects/${id}/schedule`} className="text-[11px] text-indigo-600 font-medium mt-1 inline-block">Create schedule →</Link>
                                </div>
                            )}
                            {upcoming.map((task: any) => {
                                const endDate = new Date(task.endDate);
                                const daysUntil = Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                                const isOverdue = daysUntil < 0;
                                const isDueSoon = daysUntil >= 0 && daysUntil <= 3;

                                return (
                                    <div key={task.id} className="px-4 py-3 hover:bg-slate-50/50 transition">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: task.color || '#6366f1' }} />
                                            <p className="text-xs font-medium text-hui-textMain truncate flex-1">{task.name}</p>
                                        </div>
                                        <p className={`text-[11px] mt-1 ml-4 ${isOverdue ? 'text-red-500 font-semibold' : isDueSoon ? 'text-amber-500 font-medium' : 'text-slate-400'}`}>
                                            {isOverdue ? `Overdue ${Math.abs(daysUntil)}d` :
                                             daysUntil === 0 ? 'Due today' :
                                             daysUntil === 1 ? 'Due tomorrow' :
                                             `Due in ${daysUntil}d`}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <ProjectDashboardsWidget
                        projectId={id}
                        initialPortalVisibility={portalVisibility}
                        initialSubcontractors={subList}
                    />
                </div>
            </div>

            {/* Recent Files & Photos — full-width horizontal strip */}
            <div className="mt-6 bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-gradient-to-br from-sky-100 to-blue-100 rounded-lg flex items-center justify-center">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
                        </div>
                        <h2 className="text-sm font-bold text-hui-textMain">Recent Files & Photos</h2>
                        <span className="text-[10px] text-slate-400 font-medium bg-slate-100 px-2 py-0.5 rounded-full">{recentFiles.length}</span>
                    </div>
                    <Link href={`/projects/${id}/files`} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition">
                        View all →
                    </Link>
                </div>
                {recentFiles.length === 0 ? (
                    <div className="px-6 py-10 text-center">
                        <p className="text-sm text-slate-400">No files uploaded yet</p>
                        <Link href={`/projects/${id}/files`} className="text-xs text-indigo-600 font-medium mt-1 inline-block">Upload files →</Link>
                    </div>
                ) : (
                    <div className="px-6 py-5">
                        <div className="flex gap-3 overflow-x-auto pb-1">
                            {recentFiles.map(file => {
                                const isImage = file.mimeType?.startsWith("image/");
                                return (
                                    <Link
                                        key={file.id}
                                        href={`/projects/${id}/files`}
                                        className="shrink-0 w-28 group"
                                        title={file.name}
                                    >
                                        {isImage ? (
                                            <img
                                                src={file.url}
                                                alt={file.name}
                                                loading="lazy"
                                                width={112}
                                                height={112}
                                                className="w-28 h-28 object-cover rounded-lg border border-slate-200 group-hover:border-indigo-300 group-hover:shadow-md transition"
                                            />
                                        ) : (
                                            <div className="w-28 h-28 rounded-lg border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col items-center justify-center gap-2 group-hover:border-indigo-300 group-hover:shadow-md transition">
                                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.5">
                                                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                                                    <path d="M14 2v6h6" />
                                                </svg>
                                                <span className="text-[10px] font-bold text-slate-500">{fileExt(file.name)}</span>
                                            </div>
                                        )}
                                        <p className="text-[11px] text-slate-500 mt-1.5 truncate">{file.name}</p>
                                        <p className="text-[10px] text-slate-400">{timeAgo(new Date(file.createdAt), now)}</p>
                                    </Link>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
