import { getProject, getScheduleTasks } from "@/lib/actions";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ProjectDashboardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) notFound();

    const tasks = await getScheduleTasks(id);
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
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div>
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/25">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-hui-textMain">{project.name}</h1>
                            <p className="text-sm text-hui-textMuted">{project.client?.name || "No client"} · {project.location || "No location"}</p>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
                        project.status === 'Active' ? 'bg-green-100 text-green-700' :
                        project.status === 'Completed' ? 'bg-purple-100 text-purple-700' :
                        project.status === 'On Hold' ? 'bg-amber-100 text-amber-700' :
                        'bg-slate-100 text-slate-600'
                    }`}>{project.status || 'Active'}</span>
                </div>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-4 gap-5 mb-8">
                <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">
                    <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-400 to-blue-500" />
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-1.5">Budget</p>
                    <p className="text-2xl font-bold text-hui-textMain">${totalBudget.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
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

                    {/* Recent Estimates */}
                    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
                        <div className="px-5 py-3.5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
                            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Recent Estimates</h3>
                        </div>
                        <div className="divide-y divide-slate-100">
                            {estimates.length === 0 && (
                                <div className="px-5 py-6 text-center text-xs text-slate-400">No estimates yet</div>
                            )}
                            {estimates.slice(0, 4).map((est: any) => (
                                <Link key={est.id} href={`/projects/${id}/estimates/${est.id}`} className="px-5 py-3.5 flex items-center justify-between hover:bg-slate-50/50 transition block">
                                    <div className="min-w-0">
                                        <p className="text-xs font-medium text-hui-textMain truncate">{est.title}</p>
                                        <p className="text-[10px] text-slate-400">{new Date(est.createdAt).toLocaleDateString()}</p>
                                    </div>
                                    <span className="text-xs font-semibold text-slate-600 shrink-0 ml-2">${(est.totalAmount || 0).toLocaleString()}</span>
                                </Link>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
