export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

interface Props {
    searchParams: Promise<{ userId?: string; projectId?: string; dateFrom?: string; dateTo?: string }>;
}

export default async function ManagerTimeEntriesPage({ searchParams }: Props) {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }

    const { userId, projectId, dateFrom, dateTo } = await searchParams;

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
            include: {
                user: true,
                project: true,
                costCode: true,
                estimateItem: true,
            },
            orderBy: { startTime: 'desc' },
            take: 250,
        }),
        prisma.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    const totalDuration = entries.reduce((acc, e) => acc + (e.durationHours || 0), 0);
    const totalCost = entries.reduce((acc, e) => acc + (e.laborCost || 0) + (e.burdenCost || 0), 0);
    const totalBillable = entries.reduce((acc, e) => acc + (e.laborCost || 0), 0);

    // Group by project
    const grouped = entries.reduce((map, e) => {
        const key = e.projectId;
        if (!map.has(key)) map.set(key, { project: e.project, entries: [] });
        map.get(key)!.entries.push(e);
        return map;
    }, new Map<string, { project: any; entries: any[] }>());

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-6">
            {/* Header */}
            <div className="flex justify-between items-center">
                <h1 className="text-2xl font-bold text-hui-textMain">Time &amp; Expenses</h1>
                <Link href="/manager/variance" className="hui-btn hui-btn-primary">
                    View Variance Report
                </Link>
            </div>

            {/* Filter bar */}
            <form method="GET" className="hui-card p-4 flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-hui-textMuted">Employee</label>
                    <select name="userId" defaultValue={userId || ""} className="hui-input text-sm py-1.5">
                        <option value="">All Employees</option>
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
                    <Link href="/manager/time-entries" className="hui-btn text-sm py-1.5 px-4">Clear</Link>
                )}
            </form>

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="hui-card p-5 border-l-[3px] border-l-blue-500">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Total Hours</div>
                    <div className="text-2xl font-bold text-hui-textMain">{totalDuration.toFixed(2)}h</div>
                </div>
                <div className="hui-card p-5 border-l-[3px] border-l-orange-500">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Total Billable</div>
                    <div className="text-2xl font-bold text-hui-textMain">${totalBillable.toFixed(2)}</div>
                </div>
                <div className="hui-card p-5 border-l-[3px] border-l-pink-500">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Total Cost</div>
                    <div className="text-2xl font-bold text-hui-textMain">${totalCost.toFixed(2)}</div>
                </div>
                <div className="hui-card p-5 border-l-[3px] border-l-slate-400">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Entries</div>
                    <div className="text-2xl font-bold text-hui-textMain">{entries.length}</div>
                </div>
            </div>

            {/* Grouped tables */}
            {grouped.size === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted">
                    No time entries found for the selected filters.
                </div>
            ) : (
                Array.from(grouped.values()).map(({ project, entries: pEntries }) => {
                    const pHours = pEntries.reduce((a, e) => a + (e.durationHours || 0), 0);
                    const pCost = pEntries.reduce((a, e) => a + (e.laborCost || 0) + (e.burdenCost || 0), 0);
                    return (
                        <div key={project.id} className="hui-card overflow-hidden">
                            {/* Project header */}
                            <div className="flex justify-between items-center px-6 py-3 bg-slate-50 border-b border-hui-border">
                                <span className="font-semibold text-hui-textMain">{project.name}</span>
                                <span className="text-sm text-hui-textMuted">
                                    {pHours.toFixed(2)}h &middot; ${pCost.toFixed(2)}
                                </span>
                            </div>
                            <table className="w-full text-left text-sm">
                                <thead className="border-b border-hui-border text-hui-textMuted">
                                    <tr>
                                        <th className="px-6 py-3 font-medium">Employee</th>
                                        <th className="px-6 py-3 font-medium">Phase / Budget Bucket</th>
                                        <th className="px-6 py-3 font-medium">Date</th>
                                        <th className="px-6 py-3 font-medium text-right">Duration</th>
                                        <th className="px-6 py-3 font-medium text-right">Labor Cost</th>
                                        <th className="px-6 py-3 font-medium">Audit</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border">
                                    {pEntries.map((e: any) => (
                                        <tr key={e.id} className="hover:bg-slate-50">
                                            <td className="px-6 py-3 font-medium text-hui-textMain">
                                                {e.user.name || e.user.email}
                                            </td>
                                            <td className="px-6 py-3 text-hui-textMuted text-xs">
                                                {e.estimateItem?.name || e.costCode?.name || <span className="italic">No Phase</span>}
                                            </td>
                                            <td className="px-6 py-3 text-hui-textMuted text-xs whitespace-nowrap">
                                                <div>{new Date(e.startTime).toLocaleDateString()}</div>
                                                <div>{new Date(e.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} → {e.endTime ? new Date(e.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : <span className="text-green-600 font-medium">Active</span>}</div>
                                            </td>
                                            <td className="px-6 py-3 text-right font-medium text-hui-textMain tabular-nums">
                                                {e.durationHours ? `${e.durationHours.toFixed(2)}h` : '—'}
                                            </td>
                                            <td className="px-6 py-3 text-right text-hui-textMuted tabular-nums text-xs">
                                                ${(e.laborCost || 0).toFixed(2)}
                                            </td>
                                            <td className="px-6 py-3 text-xs">
                                                {e.editedByManagerId ? (
                                                    <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">Edited</span>
                                                ) : (
                                                    <span className="text-hui-textMuted">Original</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot className="border-t border-hui-border bg-slate-50">
                                    <tr>
                                        <td colSpan={3} className="px-6 py-2 text-xs font-semibold text-hui-textMuted">Subtotal</td>
                                        <td className="px-6 py-2 text-right font-semibold text-hui-textMain tabular-nums text-sm">{pHours.toFixed(2)}h</td>
                                        <td className="px-6 py-2 text-right font-semibold text-hui-textMain tabular-nums text-sm">${pCost.toFixed(2)}</td>
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
