export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { authOptions, getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

interface Props {
    searchParams: Promise<{ userId?: string; projectId?: string; dateFrom?: string; dateTo?: string; tab?: string }>;
}

export default async function ManagerTimeEntriesPage({ searchParams }: Props) {
    const session = await getSessionOrDev();
    if (!session || !session.user) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user && process.env.NODE_ENV !== "development") {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }
    if (user && user.role !== 'MANAGER' && user.role !== 'ADMIN') {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }

    const { userId, projectId, dateFrom, dateTo, tab = 'time' } = await searchParams;

    const where: any = {};
    if (userId) where.userId = userId;
    if (projectId) where.projectId = projectId;
    if (dateFrom || dateTo) {
        where.startTime = {};
        if (dateFrom) where.startTime.gte = new Date(dateFrom);
        if (dateTo) where.startTime.lte = new Date(dateTo + "T23:59:59");
    }

    const [entries, allUsers, allProjects] = await Promise.all([
        prisma.timeEntry.findMany({
            where,
            include: { user: true, project: true, costCode: true, estimateItem: true },
            orderBy: { startTime: 'desc' },
            take: 250,
        }),
        prisma.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    const totalHours = entries.reduce((acc, e) => acc + (e.durationHours || 0), 0);
    const totalCost = entries.reduce((acc, e) => acc + (e.laborCost || 0) + (e.burdenCost || 0), 0);
    const totalBillable = entries.reduce((acc, e) => acc + (e.laborCost || 0), 0);

    // Group by project
    const grouped = entries.reduce((map, e) => {
        const key = e.projectId;
        if (!map.has(key)) map.set(key, { project: e.project, entries: [] });
        map.get(key)!.entries.push(e);
        return map;
    }, new Map<string, { project: any; entries: any[] }>());

    const filterParams = new URLSearchParams();
    if (userId) filterParams.set('userId', userId);
    if (projectId) filterParams.set('projectId', projectId);
    if (dateFrom) filterParams.set('dateFrom', dateFrom);
    if (dateTo) filterParams.set('dateTo', dateTo);

    const tabLink = (t: string) => {
        const p = new URLSearchParams(filterParams);
        p.set('tab', t);
        return `/manager/time-entries?${p.toString()}`;
    };

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-6">
            {/* Header */}
            <div className="flex justify-between items-center">
                <h1 className="text-2xl font-bold text-hui-textMain">Time &amp; Expenses</h1>
                <div className="flex items-center gap-2">
                    <a
                        href={`/api/gusto/export?${filterParams.toString()}`}
                        className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5"
                        title="Export pay period to Gusto CSV"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                        Export to Gusto
                    </a>
                    <Link href="/time-clock" className="hui-btn hui-btn-primary text-sm">
                        + New Entry
                    </Link>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-hui-border gap-0">
                <Link
                    href={tabLink('time')}
                    className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'time' ? 'border-hui-primary text-hui-primary' : 'border-transparent text-hui-textMuted hover:text-hui-textMain'}`}
                >
                    Time
                </Link>
                <Link
                    href={tabLink('expenses')}
                    className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'expenses' ? 'border-hui-primary text-hui-primary' : 'border-transparent text-hui-textMuted hover:text-hui-textMain'}`}
                >
                    Expenses
                </Link>
            </div>

            {/* Filter bar */}
            <form method="GET" className="hui-card p-4 flex flex-wrap gap-3 items-end">
                <input type="hidden" name="tab" value={tab} />
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-hui-textMuted">Team Member</label>
                    <select name="userId" defaultValue={userId || ""} className="hui-input text-sm py-1.5">
                        <option value="">All Members</option>
                        {allUsers.map(u => (
                            <option key={u.id} value={u.id}>{u.name || u.email}</option>
                        ))}
                    </select>
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-hui-textMuted">Project</label>
                    <select name="projectId" defaultValue={projectId || ""} className="hui-input text-sm py-1.5">
                        <option value="">All Projects</option>
                        {allProjects.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-hui-textMuted">From</label>
                    <input type="date" name="dateFrom" defaultValue={dateFrom || ""} className="hui-input text-sm py-1.5" />
                </div>
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-hui-textMuted">To</label>
                    <input type="date" name="dateTo" defaultValue={dateTo || ""} className="hui-input text-sm py-1.5" />
                </div>
                <button type="submit" className="hui-btn hui-btn-primary text-sm py-1.5 px-4">Filter</button>
                {(userId || projectId || dateFrom || dateTo) && (
                    <Link href={tabLink(tab)} className="hui-btn text-sm py-1.5 px-4">Clear</Link>
                )}
            </form>

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="hui-card p-6 border-l-[3px] border-l-[#2563eb]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Total Hours</div>
                    <div className="text-3xl font-bold text-hui-textMain">{totalHours.toFixed(2)}h</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-[#f97316]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Total Billable</div>
                    <div className="text-3xl font-bold text-hui-textMain">${totalBillable.toFixed(2)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-[#10b981]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Total Cost</div>
                    <div className="text-3xl font-bold text-hui-textMain">${totalCost.toFixed(2)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-[#ec4899]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Entries</div>
                    <div className="text-3xl font-bold text-hui-textMain">{entries.length}</div>
                </div>
            </div>

            {/* Content */}
            {tab === 'expenses' ? (
                <div className="hui-card p-12 text-center text-hui-textMuted">
                    <p className="font-medium text-hui-textMain mb-2">Expense tracking coming soon</p>
                    <p className="text-sm">Log expenses against project budget buckets.</p>
                </div>
            ) : grouped.size === 0 ? (
                <div className="hui-card p-12 text-center">
                    <p className="font-semibold text-hui-textMain mb-2">Start Tracking your Time</p>
                    <p className="text-sm text-hui-textMuted mb-6">No time entries found. Have your team clock in to start tracking.</p>
                    <Link href="/time-clock" className="hui-btn hui-btn-primary">Go to Time Clock</Link>
                </div>
            ) : (
                Array.from(grouped.values()).map(({ project, entries: pEntries }) => {
                    const pHours = pEntries.reduce((a, e) => a + (e.durationHours || 0), 0);
                    const pCost = pEntries.reduce((a, e) => a + (e.laborCost || 0) + (e.burdenCost || 0), 0);
                    return (
                        <div key={project.id} className="hui-card overflow-hidden">
                            <div className="flex justify-between items-center px-6 py-3 bg-slate-50 border-b border-hui-border">
                                <span className="font-semibold text-hui-textMain">{project.name}</span>
                                <span className="text-sm text-hui-textMuted tabular-nums">
                                    {pHours.toFixed(2)}h &middot; ${pCost.toFixed(2)}
                                </span>
                            </div>
                            <table className="w-full text-left text-sm">
                                <thead className="border-b border-hui-border text-hui-textMuted">
                                    <tr>
                                        <th className="px-5 py-3 font-medium">Reported By</th>
                                        <th className="px-5 py-3 font-medium">Date</th>
                                        <th className="px-5 py-3 font-medium">Service / Phase</th>
                                        <th className="px-5 py-3 font-medium text-right">Hours</th>
                                        <th className="px-5 py-3 font-medium text-right">Rate</th>
                                        <th className="px-5 py-3 font-medium text-right">Total</th>
                                        <th className="px-5 py-3 font-medium text-center">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border">
                                    {pEntries.map((e: any) => {
                                        const rate = e.durationHours && e.laborCost
                                            ? (e.laborCost / e.durationHours)
                                            : (e.user.hourlyRate || 0);
                                        const total = (e.laborCost || 0) + (e.burdenCost || 0);
                                        return (
                                            <tr key={e.id} className="hover:bg-slate-50">
                                                <td className="px-5 py-3 font-medium text-hui-textMain">
                                                    {e.user.name || e.user.email}
                                                </td>
                                                <td className="px-5 py-3 text-hui-textMuted text-xs whitespace-nowrap">
                                                    <div>{new Date(e.startTime).toLocaleDateString()}</div>
                                                    <div className="text-hui-textMuted">
                                                        {new Date(e.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        {' → '}
                                                        {e.endTime
                                                            ? new Date(e.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                                            : <span className="text-green-600 font-medium">Active</span>}
                                                    </div>
                                                </td>
                                                <td className="px-5 py-3 text-hui-textMuted text-xs">
                                                    {e.estimateItem?.name || e.costCode?.name || <span className="italic">—</span>}
                                                </td>
                                                <td className="px-5 py-3 text-right font-medium text-hui-textMain tabular-nums">
                                                    {e.durationHours ? `${e.durationHours.toFixed(2)}` : '—'}
                                                </td>
                                                <td className="px-5 py-3 text-right text-hui-textMuted tabular-nums text-xs">
                                                    ${rate.toFixed(2)}/h
                                                </td>
                                                <td className="px-5 py-3 text-right font-medium text-hui-textMain tabular-nums text-xs">
                                                    ${total.toFixed(2)}
                                                </td>
                                                <td className="px-5 py-3 text-center text-xs">
                                                    {e.editedByManagerId ? (
                                                        <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">Edited</span>
                                                    ) : (
                                                        <span className="text-green-700 bg-green-50 px-2 py-0.5 rounded border border-green-200">Original</span>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot className="border-t border-hui-border bg-slate-50">
                                    <tr>
                                        <td colSpan={3} className="px-5 py-2 text-xs font-semibold text-hui-textMuted">Subtotal</td>
                                        <td className="px-5 py-2 text-right font-bold text-hui-textMain tabular-nums">{pHours.toFixed(2)}</td>
                                        <td />
                                        <td className="px-5 py-2 text-right font-bold text-hui-textMain tabular-nums">${pCost.toFixed(2)}</td>
                                        <td />
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    );
                })
            )}
        </div>
    );
}
