import { getProject, getScheduleTasks, getPortalVisibility } from "@/lib/actions";
import { getProjectSubcontractors } from "@/lib/subcontractor-actions";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound } from "next/navigation";
import ProjectHeader from "./ProjectHeader";
import ProjectDashboardsWidget from "@/components/ProjectDashboardsWidget";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProjectDashboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) notFound();

    const [tasks, portalVisibility, subList, recentActivity] = await Promise.all([
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
            ...invs.map(i => ({ type: "invoice" as const, id: i.id, label: `Invoice ${i.code}`, sub: `${i.status} · ${formatCurrency(i.totalAmount)}`, date: new Date(i.createdAt), href: `/projects/${id}/invoices/${i.id}` })),
        ].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 8)),
    ]);
    const estimates = project.estimates || [];

    // Real stats
    const totalBudget = estimates.reduce((sum: number, e: any) => sum + (e.totalAmount || 0), 0);
    const completedTasks = tasks.filter((t: any) => t.status === "Complete").length;
    const inProgressTasks = tasks.filter((t: any) => t.status === "In Progress").length;
    const taskProgress = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0;

    // Upcoming tasks (not completed, sorted by end date)
    const upcoming = tasks
        .filter((t: any) => t.status !== "Complete")
        .sort((a: any, b: any) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())
        .slice(0, 5);

    const today = new Date();

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
            <div className="grid grid-cols-4 gap-5 mb-8">
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

            <div className="grid grid-cols-3 gap-6">
                {/* Upcoming Tasks */}
                <div className="col-span-2 bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-7 h-7 bg-gradient-to-br from-blue-100 to-indigo-100 rounded-lg flex items-center justify-center">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                            </div>
                            <h2 className="text-sm font-bold text-hui-textMain">Upcoming Tasks</h2>
                            <span className="text-[10px] text-slate-400 font-medium bg-slate-100 px-2 py-0.5 rounded-full">{upcoming.length}</span>
                        </div>
                        <Link href={`/projects/${id}/schedule`} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition">
                            View Schedule →
                        </Link>
                    </div>
                    <div className="divide-y divide-slate-100">
                        {upcoming.length === 0 && (
                            <div className="px-6 py-10 text-center">
                                <p className="text-sm text-slate-400">No upcoming tasks</p>
                                <Link href={`/projects/${id}/schedule`} className="text-xs text-indigo-600 font-medium mt-1 inline-block">Create schedule →</Link>
                            </div>
                        )}
                        {upcoming.map((task: any) => {
                            const endDate = new Date(task.endDate);
                            const daysUntil = Math.ceil((endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                            const isOverdue = daysUntil < 0;
                            const isDueSoon = daysUntil >= 0 && daysUntil <= 3;

                            return (
                                <div key={task.id} className="px-6 py-4 flex items-center justify-between hover:bg-slate-50/50 transition group">
                                    <div className="flex items-center gap-3">
                                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: task.color || '#6366f1' }} />
                                        <div>
                                            <p className="text-sm font-medium text-hui-textMain">{task.name}</p>
                                            <p className={`text-xs mt-0.5 ${isOverdue ? 'text-red-500 font-semibold' : isDueSoon ? 'text-amber-500 font-medium' : 'text-slate-400'}`}>
                                                {isOverdue ? `Overdue by ${Math.abs(daysUntil)} day${Math.abs(daysUntil) !== 1 ? 's' : ''}` :
                                                 daysUntil === 0 ? 'Due today' :
                                                 daysUntil === 1 ? 'Due tomorrow' :
                                                 `Due in ${daysUntil} days`}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className={`text-[10px] font-semibold px-2 py-1 rounded-full ${
                                            task.status === 'In Progress' ? 'bg-blue-100 text-blue-700' :
                                            task.status === 'Blocked' ? 'bg-red-100 text-red-700' :
                                            'bg-slate-100 text-slate-600'
                                        }`}>{task.status}</span>
                                        {task.progress > 0 && (
                                            <div className="w-12 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                <div className="h-full rounded-full transition-all" style={{ width: `${task.progress}%`, backgroundColor: task.color || '#6366f1' }} />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Quick Links & Estimates */}
                <div className="space-y-5">
                    
                    <ProjectDashboardsWidget 
                        projectId={id}
                        initialPortalVisibility={portalVisibility}
                        initialSubcontractors={subList}
                    />

                    {/* Quick Actions */}
                    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-5">
                        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Quick Actions</h3>
                        <div className="grid grid-cols-2 gap-2">
                            <Link href={`/projects/${id}/estimates`} className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-indigo-50 text-slate-500 hover:text-indigo-600 transition group border border-transparent hover:border-indigo-100">
                                <div className="w-9 h-9 bg-indigo-50 group-hover:bg-indigo-100 rounded-lg flex items-center justify-center transition">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg>
                                </div>
                                <span className="text-[10px] font-semibold">Estimates</span>
                            </Link>
                            <Link href={`/projects/${id}/schedule`} className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-green-50 text-slate-500 hover:text-green-600 transition group border border-transparent hover:border-green-100">
                                <div className="w-9 h-9 bg-green-50 group-hover:bg-green-100 rounded-lg flex items-center justify-center transition">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                                </div>
                                <span className="text-[10px] font-semibold">Schedule</span>
                            </Link>
                            <Link href={`/projects/${id}/invoices`} className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-amber-50 text-slate-500 hover:text-amber-600 transition group border border-transparent hover:border-amber-100">
                                <div className="w-9 h-9 bg-amber-50 group-hover:bg-amber-100 rounded-lg flex items-center justify-center transition">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                                </div>
                                <span className="text-[10px] font-semibold">Invoices</span>
                            </Link>
                            <Link href={`/projects/${id}/settings`} className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-slate-50 text-slate-500 hover:text-slate-700 transition group border border-transparent hover:border-slate-200">
                                <div className="w-9 h-9 bg-slate-50 group-hover:bg-slate-100 rounded-lg flex items-center justify-center transition">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                                </div>
                                <span className="text-[10px] font-semibold">Settings</span>
                            </Link>
                        </div>
                    </div>

                    {/* Recent Activity */}
                    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
                        <div className="px-5 py-3.5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
                            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Recent Activity</h3>
                        </div>
                        <div className="divide-y divide-slate-100">
                            {recentActivity.length === 0 && (
                                <div className="px-5 py-6 text-center text-xs text-slate-400">No activity yet</div>
                            )}
                            {recentActivity.map(event => {
                                const iconColor = event.type === "dailylog" ? "#22c55e" : event.type === "changeorder" ? "#f59e0b" : "#6366f1";
                                const iconPath = event.type === "dailylog"
                                    ? "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                    : event.type === "changeorder"
                                    ? "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                    : "M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6";
                                return (
                                    <Link key={`${event.type}-${event.id}`} href={event.href} className="px-5 py-3 flex items-start gap-3 hover:bg-slate-50/50 transition">
                                        <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5" style={{ backgroundColor: `${iconColor}18` }}>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="1.5">
                                                <path strokeLinecap="round" strokeLinejoin="round" d={iconPath} />
                                            </svg>
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs font-medium text-hui-textMain truncate">{event.label}</p>
                                            <p className="text-[10px] text-slate-400 truncate">{event.sub}</p>
                                        </div>
                                        <span className="text-[10px] text-slate-400 shrink-0">{event.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                                    </Link>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
