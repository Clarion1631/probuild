export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { authOptions, getSessionOrDev } from "@/lib/auth";
import { toNum } from "@/lib/prisma-helpers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import { markTimeEntryReviewed, decideMealSkip, setMealWaiverSigned } from "@/lib/actions";
import EntryActions from "./EntryActions";
import { COMPANY_TIME_ZONE } from "@/lib/company-day";
import { canApproveMealSkip } from "@/lib/wa-breaks";

interface Props {
    searchParams: Promise<{ userId?: string; projectId?: string; dateFrom?: string; dateTo?: string; tab?: string; flagged?: string }>;
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

    const { userId, projectId, dateFrom, dateTo, tab = 'time', flagged } = await searchParams;

    const where: any = {};
    if (userId) where.userId = userId;
    if (projectId) where.projectId = projectId;
    if (flagged === '1') where.needsReview = true;
    if (dateFrom || dateTo) {
        where.startTime = {};
        if (dateFrom) where.startTime.gte = new Date(dateFrom);
        if (dateTo) where.startTime.lte = new Date(dateTo + "T23:59:59");
    }

    const [entries, allUsers, allProjects, pendingSkips] = await Promise.all([
        prisma.timeEntry.findMany({
            where,
            include: { user: true, project: true, costCode: true, estimateItem: true },
            orderBy: { startTime: 'desc' },
            take: 250,
        }),
        prisma.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        // Skip-lunch requests waiting on an approver — always shown, regardless
        // of the filters, because a worker is standing on a job site waiting.
        prisma.timeEntry.findMany({
            where: { mealSkipStatus: 'PENDING', endTime: null },
            select: {
                id: true, startTime: true, mealSkipRequestedAt: true,
                user: { select: { id: true, name: true, email: true, mealWaiverSignedAt: true } },
                project: { select: { name: true } },
            },
            orderBy: { mealSkipRequestedAt: 'asc' },
        }),
    ]);
    const viewerCanApprove = !!user && canApproveMealSkip({ role: user.role, email: user.email });

    const flaggedCount = entries.filter(e => e.needsReview).length;
    const totalHours = entries.reduce((acc, e) => acc + (e.durationHours || 0), 0);
    const totalCost = entries.reduce((acc, e) => acc + toNum(e.laborCost) + toNum(e.burdenCost), 0);
    const totalBillable = entries.reduce((acc, e) => acc + toNum(e.laborCost), 0);

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
    if (flagged === '1') filterParams.set('flagged', '1');

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
                    <Link href="/manager/logistics" className="hui-btn hui-btn-secondary text-sm">
                        Logistics
                    </Link>
                    <Link href="/time-clock" className="hui-btn hui-btn-primary text-sm">
                        + New Entry
                    </Link>
                </div>
            </div>

            {/* Skip-lunch requests (WA express permission — src/lib/wa-breaks.ts) */}
            {pendingSkips.length > 0 && (
                <div className="hui-card p-5 border-amber-300 bg-amber-50/40">
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-base font-semibold text-hui-textMain">
                            🍽️ Skip-lunch requests waiting ({pendingSkips.length})
                        </h2>
                        {!viewerCanApprove && (
                            <span className="text-xs text-hui-textMuted">Only CJ, Richard, or Justin can approve</span>
                        )}
                    </div>
                    <ul className="divide-y divide-hui-border">
                        {pendingSkips.map((r) => {
                            const waiverOnFile = !!r.user.mealWaiverSignedAt;
                            return (
                                <li key={r.id} className="py-3 flex flex-wrap items-center gap-3 text-sm">
                                    <div className="flex-1 min-w-[220px]">
                                        <div className="font-medium text-hui-textMain">{r.user.name || r.user.email}</div>
                                        <div className="text-xs text-hui-textMuted">
                                            {r.project.name} · clocked in {new Date(r.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: COMPANY_TIME_ZONE })}
                                            {r.mealSkipRequestedAt && <> · asked {new Date(r.mealSkipRequestedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: COMPANY_TIME_ZONE })}</>}
                                        </div>
                                    </div>
                                    <div className="text-xs">
                                        {waiverOnFile ? (
                                            <span className="text-green-700 bg-green-50 px-2 py-0.5 rounded border border-green-200">Waiver signed</span>
                                        ) : (
                                            <span className="inline-flex items-center gap-2">
                                                <span className="text-red-700 bg-red-50 px-2 py-0.5 rounded border border-red-200">No waiver on file</span>
                                                {viewerCanApprove && (
                                                    <form action={async () => { "use server"; await setMealWaiverSigned(r.user.id, true); }}>
                                                        <button type="submit" className="underline text-hui-textMuted hover:text-hui-textMain" title="Marge's signed meal-period waiver is in hand">
                                                            Mark signed
                                                        </button>
                                                    </form>
                                                )}
                                            </span>
                                        )}
                                    </div>
                                    {viewerCanApprove && (
                                        <div className="flex items-center gap-2">
                                            <form action={async () => { "use server"; await decideMealSkip(r.id, "APPROVED"); }}>
                                                <button type="submit" disabled={!waiverOnFile} className="hui-btn hui-btn-primary text-xs disabled:opacity-40" title={waiverOnFile ? "Approve — paid, no deduction, no review flag" : "Needs a signed waiver first"}>
                                                    Approve
                                                </button>
                                            </form>
                                            <form action={async () => { "use server"; await decideMealSkip(r.id, "DENIED"); }}>
                                                <button type="submit" className="hui-btn hui-btn-secondary text-xs">Deny</button>
                                            </form>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

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
                <label className="flex items-center gap-1.5 text-sm text-hui-textMain py-1.5">
                    <input type="checkbox" name="flagged" value="1" defaultChecked={flagged === '1'} className="rounded border-hui-border" />
                    Needs review only
                </label>
                <button type="submit" className="hui-btn hui-btn-primary text-sm py-1.5 px-4">Filter</button>
                {(userId || projectId || dateFrom || dateTo || flagged === '1') && (
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
                    <div className="text-3xl font-bold text-hui-textMain">{formatCurrency(totalBillable)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-[#10b981]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Total Cost</div>
                    <div className="text-3xl font-bold text-hui-textMain">{formatCurrency(totalCost)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-[#ec4899]">
                    <div className="text-xs font-medium text-hui-textMuted mb-1">Entries</div>
                    <div className="text-3xl font-bold text-hui-textMain">{entries.length}</div>
                    {flaggedCount > 0 && (
                        <Link href={`/manager/time-entries?${(() => { const p = new URLSearchParams(filterParams); p.set('flagged', '1'); return p.toString(); })()}`} className="text-xs font-medium text-amber-700 hover:underline">
                            {flaggedCount} need{flaggedCount === 1 ? 's' : ''} review →
                        </Link>
                    )}
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
                    const pCost = pEntries.reduce((a, e) => a + toNum(e.laborCost) + toNum(e.burdenCost), 0);
                    return (
                        <div key={project.id} className="hui-card overflow-hidden">
                            <div className="flex justify-between items-center px-6 py-3 bg-slate-50 border-b border-hui-border">
                                <span className="font-semibold text-hui-textMain">{project.name}</span>
                                <span className="text-sm text-hui-textMuted tabular-nums">
                                    {pHours.toFixed(2)}h &middot; {formatCurrency(pCost)}
                                </span>
                            </div>
                            <table className="w-full text-left text-sm">
                                <thead className="border-b border-hui-border text-hui-textMuted">
                                    <tr>
                                        <th className="px-5 py-3 font-medium">Reported By</th>
                                        <th className="px-5 py-3 font-medium">Date</th>
                                        <th className="px-5 py-3 font-medium">Service / Phase</th>
                                        <th className="px-5 py-3 font-medium text-right" title="Paid hours (after any automatic 30-min meal deduction)">Paid hrs</th>
                                        <th className="px-5 py-3 font-medium text-center">Meal</th>
                                        <th className="px-5 py-3 font-medium text-right">Rate</th>
                                        <th className="px-5 py-3 font-medium text-right">Total</th>
                                        <th className="px-5 py-3 font-medium text-center">Status</th>
                                        <th className="px-5 py-3 font-medium text-center">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hui-border">
                                    {pEntries.map((e: any) => {
                                        const rate = e.durationHours && e.laborCost
                                            ? (toNum(e.laborCost) / e.durationHours)
                                            : toNum(e.user.hourlyRate);
                                        const total = toNum(e.laborCost) + toNum(e.burdenCost);
                                        return (
                                            <tr key={e.id} className="hover:bg-slate-50">
                                                <td className="px-5 py-3 font-medium text-hui-textMain">
                                                    {e.user.name || e.user.email}
                                                </td>
                                                <td className="px-5 py-3 text-hui-textMuted text-xs whitespace-nowrap">
                                                    <div>{new Date(e.startTime).toLocaleDateString('en-US', { timeZone: COMPANY_TIME_ZONE })}</div>
                                                    <div className="text-hui-textMuted">
                                                        {new Date(e.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: COMPANY_TIME_ZONE })}
                                                        {' → '}
                                                        {e.endTime
                                                            ? new Date(e.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: COMPANY_TIME_ZONE })
                                                            : <span className="text-green-600 font-medium">Active</span>}
                                                    </div>
                                                </td>
                                                <td className="px-5 py-3 text-hui-textMuted text-xs">
                                                    {e.estimateItem?.name || e.costCode?.name || <span className="italic">—</span>}
                                                </td>
                                                <td className="px-5 py-3 text-right font-medium text-hui-textMain tabular-nums" title={e.shiftHours != null && e.mealDeductionHours ? `${e.shiftHours.toFixed(2)} on the clock − ${e.mealDeductionHours.toFixed(2)} meal` : undefined}>
                                                    {e.durationHours ? `${e.durationHours.toFixed(2)}` : '—'}
                                                </td>
                                                <td className="px-5 py-3 text-center text-xs">
                                                    {e.mealOutcome === 'AUTO_DEDUCTED' ? <span className="text-hui-textMuted" title={`${Math.round((e.mealDeductionHours ?? 0.5) * 60)} min unpaid meal deducted automatically`}>−{Math.round((e.mealDeductionHours ?? 0.5) * 60)}m</span>
                                                        : e.mealOutcome === 'DEFERRED' ? <span className="text-hui-textMuted" title="Mid-day close (lunch / task switch) — the day settles on the final clock-out">mid-day</span>
                                                        : e.mealOutcome === 'PUNCHED' ? <span className="text-hui-textMuted" title="Worker clocked out for a meal">taken</span>
                                                        : e.mealOutcome === 'WORKED_THROUGH' ? <span className="text-red-700" title="Worker reported working through lunch — paid, needs review">worked thru</span>
                                                        : e.mealOutcome === 'WAIVED_APPROVED' ? <span className="text-green-700" title="Skip approved in advance by a manager">approved skip</span>
                                                        : e.mealOutcome === 'NOT_REQUIRED' ? <span className="text-hui-textMuted">—</span>
                                                        : e.mealSkipStatus === 'PENDING' ? <span className="text-amber-700">skip pending</span>
                                                        : <span className="text-hui-textMuted">—</span>}
                                                    {e.restBreaksMissed && <div className="text-red-700" title="Worker reported a missed 10-min rest break — paid, needs review">rest missed</div>}
                                                </td>
                                                <td className="px-5 py-3 text-right text-hui-textMuted tabular-nums text-xs">
                                                    {formatCurrency(rate)}/h
                                                </td>
                                                <td className="px-5 py-3 text-right font-medium text-hui-textMain tabular-nums text-xs">
                                                    {formatCurrency(total)}
                                                </td>
                                                <td className="px-5 py-3 text-center text-xs">
                                                    {e.needsReview ? (
                                                        <div className="flex flex-col items-center gap-1">
                                                            <span
                                                                className="text-red-700 bg-red-50 px-2 py-0.5 rounded border border-red-200"
                                                                title={e.reviewReason || (e.mealSkipped ? "Meal break waived by worker" : "Flagged for review")}
                                                            >
                                                                Needs review{e.mealSkipped ? " · meal waived" : ""}
                                                            </span>
                                                            <form action={async () => { "use server"; await markTimeEntryReviewed(e.id); }}>
                                                                <button type="submit" className="text-hui-textMuted hover:text-hui-textMain underline">
                                                                    Mark reviewed
                                                                </button>
                                                            </form>
                                                        </div>
                                                    ) : e.isEdited ? (
                                                        <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200" title={e.editedByManagerId ? "Edited by a manager/admin" : "Edited by the worker"}>
                                                            {e.editedByManagerId ? "Edited" : "Edited (worker)"}
                                                        </span>
                                                    ) : (
                                                        <span className="text-green-700 bg-green-50 px-2 py-0.5 rounded border border-green-200">Original</span>
                                                    )}
                                                </td>
                                                <td className="px-5 py-3 text-center text-xs">
                                                    <EntryActions
                                                        entryId={e.id}
                                                        userName={e.user.name || e.user.email}
                                                        startTime={new Date(e.startTime).toISOString()}
                                                        endTime={e.endTime ? new Date(e.endTime).toISOString() : null}
                                                        isLogistics={!!e.project?.isLogistics}
                                                    />
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot className="border-t border-hui-border bg-slate-50">
                                    <tr>
                                        {/* 9 columns: label×3, Paid hrs, Meal+Rate, Total, Status+Actions */}
                                        <td colSpan={3} className="px-5 py-2 text-xs font-semibold text-hui-textMuted">Subtotal</td>
                                        <td className="px-5 py-2 text-right font-bold text-hui-textMain tabular-nums">{pHours.toFixed(2)}</td>
                                        <td colSpan={2} />
                                        <td className="px-5 py-2 text-right font-bold text-hui-textMain tabular-nums">{formatCurrency(pCost)}</td>
                                        <td colSpan={2} />
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
