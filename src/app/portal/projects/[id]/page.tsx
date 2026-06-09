import { prisma } from "@/lib/prisma";
import Link from 'next/link';
import { notFound } from "next/navigation";
import StatusBadge, { StatusType } from "@/components/StatusBadge";
import PortalPayButton from "@/components/PortalPayButton";
import PortalProjectTabs, { type PortalTab } from "@/components/PortalProjectTabs";
import { getPortalVisibility, getScheduleTasks } from "@/lib/actions";
import { formatCurrency } from "@/lib/utils";
import PortalVisitTracker from "@/components/PortalVisitTracker";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

const ALLOWED_TABS = [
    "overview", "estimates", "schedule", "invoices",
    "updates", "files", "selections", "designs", "change-orders"
] as const;
type TabId = (typeof ALLOWED_TABS)[number];

export default async function PortalProjectDetail(props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ tab?: string }>;
}) {
    const params = await props.params;
    const searchParams = await props.searchParams;
    const projectId = params.id;

    const staffSession = await getServerSession(authOptions);
    const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

    let projectWhere: any;
    if (isStaff) {
        projectWhere = { id: projectId };
    } else {
        const sessionClientId = await resolveSessionClientId();
        if (!sessionClientId) return notFound();
        projectWhere = { id: projectId, clientId: sessionClientId };
    }

    const project = await prisma.project.findFirst({
        where: projectWhere,
        include: {
            client: true,
            estimates: {
                where: { privacy: 'Shared', status: { not: 'Draft' }, deletedAt: null },
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true, number: true, title: true, code: true, status: true,
                    privacy: true, totalAmount: true, balanceDue: true, createdAt: true,
                    projectId: true, approvedBy: true, approvedAt: true, signatureUrl: true, viewedAt: true,
                },
            },
            invoices: {
                where: { status: { not: 'Draft' } },
                orderBy: { issueDate: 'desc' },
                include: {
                    payments: { orderBy: { createdAt: 'asc' } }
                }
            },
            changeOrders: {
                where: { status: { not: 'Draft' } },
                orderBy: { createdAt: 'desc' },
                include: { estimate: { select: { id: true, code: true, title: true, status: true, totalAmount: true } } }
            },
            dailyLogs: {
                orderBy: { date: 'desc' },
                include: {
                    photos: { orderBy: { createdAt: 'asc' } },
                    createdBy: { select: { name: true, email: true } }
                }
            }
        }
    });

    if (!project) return notFound();

    const [settings, visibility, scheduleTasks] = await Promise.all([
        prisma.companySettings.findUnique({ where: { id: "singleton" } }),
        getPortalVisibility(projectId),
        getScheduleTasks(projectId).catch(() => [] as any[]),
    ]);

    if (!visibility.isPortalEnabled) {
        return (
            <div className="max-w-3xl mx-auto py-16 px-4 text-center">
                <div className="bg-white border text-center border-slate-200 rounded-xl p-8 shadow-sm">
                    <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                    </div>
                    <h2 className="text-2xl font-bold text-slate-800 mb-2">Access Suspended</h2>
                    <p className="text-slate-500 mb-6 max-w-md mx-auto">
                        Your contractor has currently paused access to this project's dashboard. Please contact them directly if you need to review any project materials or estimates.
                    </p>
                    <Link href="/portal" className="inline-flex justify-center items-center gap-2 hui-btn hui-btn-primary">
                        Return to My Hub
                    </Link>
                </div>
            </div>
        );
    }

    // ---- Compute counts and tab config ----
    const estimateCount = project.estimates.length;
    const invoiceCount = project.invoices.length;
    const updateCount = (project.dailyLogs || []).length;
    const changeOrderCount = (project.changeOrders || []).length;

    // All overview-derived data must respect the same visibility flag as the section it surfaces.
    const pendingPayments: { invoiceId: string; payment: any }[] = [];
    if (visibility.showInvoices) {
        for (const inv of project.invoices) {
            for (const p of (inv.payments || [])) {
                if (p.status === 'Pending') pendingPayments.push({ invoiceId: inv.id, payment: p });
            }
        }
    }
    const totalDue = pendingPayments.reduce((sum, x) => sum + Number(x.payment.amount), 0);

    const sentEstimatesAwaitingSignature = visibility.showEstimates
        ? project.estimates.filter((e: any) => e.status === 'Sent' && !e.approvedAt)
        : [];
    const pendingChangeOrders = (visibility as any).showChangeOrders !== false
        ? (project.changeOrders || []).filter((co: any) => co.status === 'Sent')
        : [];

    const showChangeOrders = (visibility as any).showChangeOrders !== false;

    const tabsConfig: Array<{ id: TabId; label: string; count?: number; visible: boolean }> = [
        { id: "overview", label: "Overview", visible: true },
        { id: "estimates", label: "Estimates", count: estimateCount, visible: visibility.showEstimates && estimateCount > 0 },
        { id: "schedule", label: "Schedule", visible: visibility.showSchedule },
        { id: "invoices", label: "Invoices", count: invoiceCount, visible: visibility.showInvoices && invoiceCount > 0 },
        { id: "updates", label: "Updates", count: updateCount, visible: visibility.showDailyLogs && updateCount > 0 },
        { id: "files", label: "Files", visible: visibility.showFiles },
        { id: "selections", label: "Selections", visible: visibility.showSelections },
        { id: "designs", label: "Designs", visible: visibility.showMoodBoards },
        { id: "change-orders", label: "Change Orders", count: changeOrderCount, visible: showChangeOrders && changeOrderCount > 0 },
    ];

    const visibleTabs = tabsConfig.filter(t => t.visible);
    const visibleTabIds = new Set(visibleTabs.map(t => t.id));

    const requestedTab = (searchParams.tab || "overview") as TabId;
    const activeTab: TabId = visibleTabIds.has(requestedTab) ? requestedTab : "overview";

    const tabs: PortalTab[] = visibleTabs.map(t => ({
        id: t.id,
        label: t.label,
        count: t.count,
        href: t.id === "overview"
            ? `/portal/projects/${projectId}`
            : `/portal/projects/${projectId}?tab=${t.id}`,
    }));

    // ---- Schedule summary for Overview + Schedule tab ----
    const isTaskComplete = (t: any) => (t.progress ?? 0) >= 100 || t.status === 'Complete';
    const totalTasks = scheduleTasks.length;
    const completedTasks = scheduleTasks.filter(isTaskComplete).length;
    const inProgressTask = scheduleTasks.find((t: any) =>
        !isTaskComplete(t) && ((t.progress ?? 0) > 0 || t.status === 'In Progress')
    );
    const upcomingTasks = scheduleTasks
        .filter((t: any) => !isTaskComplete(t))
        .slice()
        .sort((a: any, b: any) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
        .slice(0, 4);
    const overallProgress = totalTasks > 0
        ? Math.round((completedTasks / totalTasks) * 100)
        : 0;

    const latestLog = (visibility.showDailyLogs && project.dailyLogs && project.dailyLogs.length > 0)
        ? project.dailyLogs[0]
        : null;
    const hasScheduleData = visibility.showSchedule && totalTasks > 0;

    return (
        <div className="max-w-5xl mx-auto">
            {!isStaff && <PortalVisitTracker projectId={projectId} clientName={project.client?.name || "Client"} />}
            {isStaff && (
                <div className="mb-4 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    Staff Preview — this is what the client sees
                </div>
            )}

            <div className="mb-4">
                <Link href="/portal" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm w-fit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back to Dashboard
                </Link>
            </div>

            <div className="hui-card p-6 md:p-8 mb-6">
                <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0">
                        <h1 className="text-2xl md:text-3xl font-bold text-hui-textMain mb-2 truncate">{project.name}</h1>
                        <div className="flex gap-2 md:gap-3 text-sm text-hui-textMuted flex-wrap items-center">
                            {project.location && <span className="truncate">{project.location}</span>}
                            {project.location && <span aria-hidden>•</span>}
                            <span>Started {new Date(project.createdAt).toLocaleDateString()}</span>
                        </div>
                    </div>
                    <div className="shrink-0">
                        <StatusBadge status={project.status as StatusType} />
                    </div>
                </div>
            </div>

            <PortalProjectTabs tabs={tabs} activeTab={activeTab} />

            <div
                role="tabpanel"
                id={`panel-${activeTab}`}
                aria-labelledby={`tab-${activeTab}`}
                key={activeTab}
                className="pb-8"
            >
                {activeTab === "overview" && (
                    <div className="space-y-6">
                        {/* Payment Due callout */}
                        {pendingPayments.length > 0 && (
                            <div className="bg-green-50 border border-green-200 rounded-xl p-5 md:p-6">
                                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                                    <div>
                                        <div className="flex items-center gap-2 text-green-800 font-semibold mb-1">
                                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                            Payment Due
                                        </div>
                                        <p className="text-2xl md:text-3xl font-bold text-green-900">{formatCurrency(totalDue)}</p>
                                        <p className="text-sm text-green-700 mt-1">
                                            {pendingPayments.length === 1
                                                ? `Due ${pendingPayments[0].payment.dueDate ? new Date(pendingPayments[0].payment.dueDate).toLocaleDateString() : 'soon'}`
                                                : `${pendingPayments.length} payments awaiting your approval`
                                            }
                                        </p>
                                    </div>
                                    <div className="shrink-0">
                                        {pendingPayments.length === 1 ? (
                                            <PortalPayButton
                                                invoiceId={pendingPayments[0].invoiceId}
                                                paymentScheduleId={pendingPayments[0].payment.id}
                                                amount={Number(pendingPayments[0].payment.amount)}
                                                label="Pay Now"
                                                settings={settings}
                                            />
                                        ) : (
                                            <Link
                                                href={`/portal/projects/${projectId}?tab=invoices`}
                                                className="inline-flex items-center justify-center gap-2 hui-btn hui-btn-green"
                                            >
                                                View Invoices
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                            </Link>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Action needed alerts */}
                        {(sentEstimatesAwaitingSignature.length > 0 || pendingChangeOrders.length > 0) && (
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
                                <h3 className="font-semibold text-amber-900 mb-3 flex items-center gap-2">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                                    Action Needed
                                </h3>
                                <ul className="space-y-2">
                                    {sentEstimatesAwaitingSignature.map((est: any) => (
                                        <li key={est.id}>
                                            <Link href={`/portal/estimates/${est.id}`} className="flex items-center justify-between gap-3 text-sm text-amber-900 hover:text-amber-700 transition">
                                                <span className="truncate"><span className="font-medium">{est.title}</span> awaiting signature</span>
                                                <span className="text-xs font-semibold underline shrink-0">Review →</span>
                                            </Link>
                                        </li>
                                    ))}
                                    {pendingChangeOrders.map((co: any) => (
                                        <li key={co.id}>
                                            <Link href={`/portal/change-orders/${co.id}`} className="flex items-center justify-between gap-3 text-sm text-amber-900 hover:text-amber-700 transition">
                                                <span className="truncate"><span className="font-medium">Change Order: {co.title}</span> awaiting approval</span>
                                                <span className="text-xs font-semibold underline shrink-0">Review →</span>
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Schedule + Latest Update row */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {/* Schedule mini summary */}
                            {hasScheduleData && (
                                <Link
                                    href={`/portal/projects/${projectId}?tab=schedule`}
                                    className="hui-card p-5 hover:shadow-md hover:border-blue-300 transition"
                                >
                                    <div className="flex items-center justify-between mb-3">
                                        <h3 className="font-semibold text-hui-textMain flex items-center gap-2">
                                            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                            Schedule
                                        </h3>
                                        <span className="text-xs font-semibold text-blue-500">{overallProgress}%</span>
                                    </div>
                                    <div className="w-full bg-slate-100 rounded-full h-2 mb-3">
                                        <div className="bg-blue-500 h-2 rounded-full transition-all" style={{ width: `${overallProgress}%` }} />
                                    </div>
                                    <p className="text-sm text-hui-textMuted">
                                        {completedTasks} of {totalTasks} tasks complete
                                        {inProgressTask && <> · Now: <span className="text-hui-textMain font-medium">{inProgressTask.name}</span></>}
                                    </p>
                                </Link>
                            )}

                            {/* Latest update preview */}
                            {visibility.showDailyLogs && latestLog && (
                                <Link
                                    href={`/portal/projects/${projectId}?tab=updates`}
                                    className="hui-card p-5 hover:shadow-md hover:border-purple-300 transition"
                                >
                                    <div className="flex items-center justify-between mb-2">
                                        <h3 className="font-semibold text-hui-textMain flex items-center gap-2">
                                            <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                            Latest Update
                                        </h3>
                                        <span className="text-xs text-hui-textMuted">{new Date(latestLog.date).toLocaleDateString()}</span>
                                    </div>
                                    <p className="text-sm text-hui-textMain line-clamp-2 mb-3">
                                        {latestLog.workPerformed}
                                    </p>
                                    {latestLog.photos && latestLog.photos.length > 0 && (
                                        <div className="flex gap-2">
                                            {latestLog.photos.slice(0, 4).map((photo: any) => (
                                                <div key={photo.id} className="w-12 h-12 rounded overflow-hidden border border-slate-200 shrink-0">
                                                    <img src={photo.url} alt="" className="w-full h-full object-cover" />
                                                </div>
                                            ))}
                                            {latestLog.photos.length > 4 && (
                                                <div className="w-12 h-12 rounded bg-slate-50 border border-slate-200 flex items-center justify-center text-xs font-semibold text-slate-500">
                                                    +{latestLog.photos.length - 4}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </Link>
                            )}
                        </div>

                        {/* Empty overview fallback — based on what would actually render */}
                        {pendingPayments.length === 0
                            && sentEstimatesAwaitingSignature.length === 0
                            && pendingChangeOrders.length === 0
                            && !latestLog
                            && !hasScheduleData
                            && (
                                <div className="hui-card p-8 text-center">
                                    <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-3">
                                        <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    </div>
                                    <h3 className="font-semibold text-hui-textMain mb-1">Your project is set up</h3>
                                    <p className="text-sm text-hui-textMuted max-w-md mx-auto">
                                        Your contractor will share updates, estimates, and schedule details here as the project progresses.
                                    </p>
                                </div>
                            )}
                    </div>
                )}

                {activeTab === "estimates" && (
                    <div className="space-y-3">
                        {project.estimates.map(est => (
                            <Link href={`/portal/estimates/${est.id}`} key={est.id} className="block hui-card p-4 hover:border-blue-300 hover:shadow-sm transition">
                                <div className="flex justify-between items-start mb-2 gap-2">
                                    <h3 className="font-semibold text-hui-textMain truncate">{est.title}</h3>
                                    <span className={`text-xs px-2 py-1 rounded-full font-medium shrink-0 ${est.status === 'Approved' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                        {est.status}
                                    </span>
                                </div>
                                <div className="flex justify-between text-sm text-hui-textMuted">
                                    <span>Total: {formatCurrency(est.totalAmount)}</span>
                                    <span>{new Date(est.createdAt).toLocaleDateString()}</span>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}

                {activeTab === "schedule" && (
                    <div className="space-y-4">
                        {totalTasks === 0 ? (
                            <div className="bg-hui-background border border-hui-border rounded-lg p-6 text-center text-hui-textMuted text-sm">
                                No schedule shared yet.
                            </div>
                        ) : (
                            <>
                                <div className="hui-card p-5">
                                    <div className="flex items-center justify-between mb-2">
                                        <h3 className="font-semibold text-hui-textMain">Overall Progress</h3>
                                        <span className="text-sm font-semibold text-blue-600">{overallProgress}%</span>
                                    </div>
                                    <div className="w-full bg-slate-100 rounded-full h-3 mb-2">
                                        <div className="bg-blue-500 h-3 rounded-full transition-all" style={{ width: `${overallProgress}%` }} />
                                    </div>
                                    <p className="text-sm text-hui-textMuted">
                                        {completedTasks} of {totalTasks} tasks complete
                                        {inProgressTask && (
                                            <> · Now: <span className="text-hui-textMain font-medium">{inProgressTask.name}</span></>
                                        )}
                                    </p>
                                </div>

                                {upcomingTasks.length > 0 && (
                                    <div className="hui-card p-5">
                                        <h3 className="font-semibold text-hui-textMain mb-3">Upcoming Tasks</h3>
                                        <ul className="divide-y divide-hui-border">
                                            {upcomingTasks.map((task: any) => (
                                                <li key={task.id} className="py-3 flex items-center justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium text-hui-textMain truncate">{task.name}</p>
                                                        <p className="text-xs text-hui-textMuted">
                                                            {new Date(task.startDate).toLocaleDateString()} – {new Date(task.endDate).toLocaleDateString()}
                                                        </p>
                                                    </div>
                                                    <span className="text-xs px-2 py-1 rounded-full font-medium bg-slate-100 text-slate-600 shrink-0">
                                                        {task.status || "Not Started"}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                <Link
                                    href={`/portal/projects/${projectId}/schedule`}
                                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700 transition"
                                >
                                    View full timeline
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                </Link>
                            </>
                        )}
                    </div>
                )}

                {activeTab === "invoices" && (
                    <div className="space-y-3">
                        {project.invoices.map(inv => (
                            <div key={inv.id} className="hui-card p-4">
                                <div className="flex justify-between items-start mb-2 gap-2">
                                    <h3 className="font-semibold text-hui-textMain">Invoice #{inv.code}</h3>
                                    <span className={`text-xs px-2 py-1 rounded-full font-medium shrink-0 ${inv.status === 'Paid' ? 'bg-green-100 text-green-700' :
                                            inv.status === 'Overdue' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-800'
                                        }`}>
                                        {inv.status}
                                    </span>
                                </div>
                                <div className="flex justify-between text-sm mb-4">
                                    <span className="text-hui-textMuted">Amount: {formatCurrency(inv.totalAmount)}</span>
                                    <span className="font-medium text-hui-textMain">Due: {formatCurrency(inv.balanceDue)}</span>
                                </div>

                                {inv.payments && inv.payments.length > 0 && (
                                    <div className="space-y-2 border-t border-hui-border pt-3 mt-3">
                                        {inv.payments.map((payment: any) => (
                                            <div key={payment.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 bg-slate-50 rounded-md border border-slate-100 gap-3">
                                                <div>
                                                    <p className="text-sm font-semibold text-hui-textMain flex items-center gap-2">
                                                        {payment.name}
                                                        {payment.status === 'Paid' && (
                                                            <span className="inline-flex items-center text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full border border-green-200">
                                                                <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                                Paid {payment.paymentMethod ? `via ${payment.paymentMethod.toUpperCase()}` : ''}
                                                            </span>
                                                        )}
                                                        {payment.status === 'Processing' && (
                                                            <span className="text-xs text-yellow-600 bg-yellow-50 px-1.5 py-0.5 rounded-md border border-yellow-200">
                                                                Processing ACH
                                                            </span>
                                                        )}
                                                    </p>
                                                    {payment.dueDate && (
                                                        <p className="text-xs text-hui-textMuted mt-0.5">Due: {new Date(payment.dueDate).toLocaleDateString()}</p>
                                                    )}
                                                </div>
                                                <div className="flex flex-col sm:items-end w-full sm:w-auto mt-2 sm:mt-0">
                                                    {payment.status === 'Pending' ? (
                                                        <PortalPayButton
                                                            invoiceId={inv.id}
                                                            paymentScheduleId={payment.id}
                                                            amount={Number(payment.amount)}
                                                            label="Pay Now"
                                                            settings={settings}
                                                        />
                                                    ) : (
                                                        <span className="text-sm font-medium text-hui-textMain">{formatCurrency(payment.amount)}</span>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {activeTab === "updates" && (
                    <div className="space-y-4">
                        {project.dailyLogs.map((log: any) => (
                            <div key={log.id} className="hui-card p-5 border-l-4 border-l-purple-500">
                                <div className="flex items-start justify-between mb-3 border-b border-slate-100 pb-3 flex-wrap gap-2">
                                    <div>
                                        <h3 className="font-bold text-hui-textMain text-base md:text-lg">
                                            {new Date(log.date).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
                                        </h3>
                                        <p className="text-xs text-hui-textMuted mt-1">
                                            Logged by {log.createdBy.name || log.createdBy.email}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {log.weather && (
                                            <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full border border-blue-100">
                                                ☁️ {log.weather}
                                            </span>
                                        )}
                                        {log.crewOnSite && (
                                            <span className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 px-2 py-1 rounded-full border border-green-100">
                                                👥 Crew on Site
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <div>
                                        <p className="text-xs font-bold text-hui-textMuted uppercase tracking-wider mb-1">Work Performed</p>
                                        <div className="text-sm text-hui-textMain bg-slate-50 p-3 rounded-lg border border-slate-100 whitespace-pre-wrap leading-relaxed">
                                            {log.workPerformed}
                                        </div>
                                    </div>

                                    {log.materialsDelivered && (
                                        <div>
                                            <p className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-1">Materials Delivered</p>
                                            <div className="text-sm text-hui-textMain bg-amber-50/50 p-3 rounded-lg border border-amber-100/50 whitespace-pre-wrap">
                                                {log.materialsDelivered}
                                            </div>
                                        </div>
                                    )}

                                    {log.issues && (
                                        <div>
                                            <p className="text-xs font-bold text-red-600 uppercase tracking-wider mb-1">⚠️ Issues / Delays</p>
                                            <div className="text-sm text-hui-textMain bg-red-50/50 p-3 rounded-lg border border-red-100/50 whitespace-pre-wrap">
                                                {log.issues}
                                            </div>
                                        </div>
                                    )}

                                    {log.photos && log.photos.length > 0 && (
                                        <div>
                                            <p className="text-xs font-bold text-hui-textMuted uppercase tracking-wider mb-2">Photos</p>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                                {log.photos.map((photo: any) => (
                                                    <div key={photo.id} className="relative aspect-square rounded-lg overflow-hidden border border-slate-200">
                                                        <img src={photo.url} alt="Daily Log Image" className="w-full h-full object-cover" />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {activeTab === "files" && (
                    <Link href={`/portal/projects/${projectId}/files`} className="block hui-card p-6 hover:border-blue-500 hover:shadow-md transition text-center border-dashed">
                        <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-3">
                            <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>
                        </div>
                        <h3 className="text-base font-bold text-slate-800">View Shared Files</h3>
                        <p className="text-sm text-slate-500 mt-1">Access project documents, plans, and photos shared by your contractor.</p>
                    </Link>
                )}

                {activeTab === "selections" && (
                    <Link href={`/portal/projects/${projectId}/selections`} className="block hui-card p-6 hover:border-hui-primary hover:shadow-md transition text-center border-dashed">
                        <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-3">
                            <svg className="w-6 h-6 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <h3 className="text-base font-bold text-slate-800">Review Project Selections</h3>
                        <p className="text-sm text-slate-500 mt-1">Make your choices for finishes, materials, and fixtures.</p>
                    </Link>
                )}

                {activeTab === "designs" && (
                    <Link href={`/portal/projects/${projectId}/mood-boards`} className="block hui-card p-6 hover:border-indigo-500 hover:shadow-md transition text-center border-dashed">
                        <div className="w-12 h-12 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-3">
                            <svg className="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                            </svg>
                        </div>
                        <h3 className="text-base font-bold text-slate-800">View Design Concepts</h3>
                        <p className="text-sm text-slate-500 mt-1">Explore visual layouts and material choices for your space.</p>
                    </Link>
                )}

                {activeTab === "change-orders" && (
                    <div className="space-y-3">
                        {project.changeOrders.map((co: any) => (
                            <Link href={`/portal/change-orders/${co.id}`} key={co.id} className="block hui-card p-4 hover:border-amber-300 hover:shadow-sm transition">
                                <div className="flex justify-between items-start mb-2 gap-2">
                                    <h3 className="font-semibold text-hui-textMain truncate">{co.title}</h3>
                                    <span className={`text-xs px-2 py-1 rounded-full font-medium shrink-0 ${co.status === 'Approved' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                        {co.status}
                                    </span>
                                </div>
                                <div className="flex justify-between text-sm text-hui-textMuted">
                                    <span>Amount: {formatCurrency(co.totalAmount)}</span>
                                    <span>{new Date(co.createdAt).toLocaleDateString()}</span>
                                </div>
                                <div className="mt-2 text-xs text-slate-400 truncate">
                                    Original Est: {co.estimate?.title || co.estimate?.code}
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
