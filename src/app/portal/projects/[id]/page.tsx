import { prisma } from "@/lib/prisma";
import Link from 'next/link';
import { notFound } from "next/navigation";
import StatusBadge, { StatusType } from "@/components/StatusBadge";
import PortalPayButton from "@/components/PortalPayButton";
import PortalProjectTabs, { type PortalTab } from "@/components/PortalProjectTabs";
import { getPortalVisibility } from "@/lib/actions";
import { getUnreadSelectionThreadCountForPortal } from "@/lib/selection-item-thread-dependencies";
import { formatCurrency } from "@/lib/utils";
import PortalVisitTracker from "@/components/PortalVisitTracker";
import PortalWelcomeGuide from "@/components/PortalWelcomeGuide";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import PortalProjectTracker from "./PortalProjectTracker";
import PortalStagePin from "./PortalStagePin";
import PortalUpdatesFeed from "./PortalUpdatesFeed";
import {
    CLIENT_STAGES,
    getPortalProjectTracker,
    getPortalUpdatesFeed,
} from "@/lib/portal-tracker";

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

    // Self-healing payment state: if any milestone on this project is still
    // Pending but lives on the QuickBooks rail, pull settled payments NOW so a
    // client returning from the Intuit pay page sees "Paid" immediately
    // (the hourly cron remains the backstop).
    const pendingQB = await prisma.paymentSchedule.findFirst({
        where: { status: "Pending", qbInvoiceId: { not: null }, invoice: { projectId } },
        select: { id: true },
    });
    if (pendingQB) {
        const { syncQuickBooksPayments } = await import("@/lib/quickbooks-payments");
        await syncQuickBooksPayments({ projectId }).catch(() => {});
    }

    const project = await prisma.project.findFirst({
        where: projectWhere,
        include: {
            client: true,
            estimates: {
                where: { privacy: 'Shared', status: { not: 'Draft' } },
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
            }
        }
    });

    if (!project) return notFound();

    const visibility = await getPortalVisibility(projectId);
    const [settings, trackerData, updatesFeed, sharedRooms, unreadSelectionThreadCount] = await Promise.all([
        prisma.companySettings.findUnique({ where: { id: "singleton" } }),
        visibility.showSchedule
            ? getPortalProjectTracker(projectId)
            : Promise.resolve(null),
        visibility.showDailyLogs
            ? getPortalUpdatesFeed(projectId)
            : Promise.resolve([]),
        prisma.roomDesign.findMany({
            where: { projectId, shareEnabled: true, shareToken: { not: null } },
            select: { id: true, name: true, shareToken: true, thumbnail: true, updatedAt: true },
            orderBy: { updatedAt: "desc" },
        }),
        visibility.showSelections
            ? getUnreadSelectionThreadCountForPortal(projectId)
            : Promise.resolve(0),
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
                        Your contractor has currently paused access to this project&apos;s dashboard. Please contact them directly if you need to review any project materials or estimates.
                    </p>
                    <Link href="/portal" className="inline-flex justify-center items-center gap-2 hui-btn hui-btn-primary">
                        Return to My Hub
                    </Link>
                </div>
            </div>
        );
    }

    // ---- Compute counts and tab config ----
    const estimateCount = project.estimates.filter((e: any) => e.approvedAt || ['Approved', 'Invoiced', 'Partially Paid', 'Paid'].includes(e.status)).length;
    const invoiceCount = project.invoices.length;
    const updateCount = updatesFeed.length;
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
        { id: "updates", label: "Updates", count: updateCount || undefined, visible: visibility.showDailyLogs },
        { id: "files", label: "Files", visible: visibility.showFiles },
        { id: "selections", label: "Selections", count: unreadSelectionThreadCount || undefined, visible: visibility.showSelections },
        { id: "designs", label: "Designs", visible: visibility.showMoodBoards || sharedRooms.length > 0 },
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

    return (
        <div className="max-w-5xl mx-auto">
            {!isStaff && <PortalVisitTracker projectId={projectId} clientName={project.client?.name || "Client"} />}
            {isStaff && (
                <div className="mb-4 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex flex-wrap items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    Staff Preview — this is what the client sees
                    <PortalStagePin
                        projectId={projectId}
                        stageLabels={CLIENT_STAGES.map(stage => stage.label)}
                        currentOverride={project.portalStageOverride}
                    />
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
                        {trackerData && (
                            <PortalProjectTracker
                                projectId={projectId}
                                projectName={project.name}
                                data={trackerData}
                            />
                        )}

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
                                                qbPayLink={pendingPayments[0].payment.qbInvoiceLink || null}
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

                        {/* Dismissible how-it-works guide (items follow visibility flags) */}
                        <PortalWelcomeGuide
                            projectId={projectId}
                            companyName={settings?.companyName || "Your contractor"}
                            features={{
                                schedule: visibility.showSchedule,
                                updates: visibility.showDailyLogs,
                                estimates: visibility.showEstimates,
                                invoices: visibility.showInvoices,
                                selections: visibility.showSelections,
                                files: visibility.showFiles,
                            }}
                        />

                        {/* Empty overview fallback — based on what would actually render */}
                        {pendingPayments.length === 0
                            && sentEstimatesAwaitingSignature.length === 0
                            && pendingChangeOrders.length === 0
                            && !trackerData
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
                        {project.estimates
                            .filter(est => est.approvedAt || ['Approved', 'Invoiced', 'Partially Paid', 'Paid'].includes(est.status))
                            .map(est => {
                                const isSigned = !!est.approvedAt;
                            return (
                            <Link href={`/portal/estimates/${est.id}`} key={est.id} className="block hui-card p-4 hover:border-blue-300 hover:shadow-sm transition">
                                <div className="flex justify-between items-start mb-2 gap-2">
                                    <h3 className="font-semibold text-hui-textMain truncate">{est.title}</h3>
                                    <span className={`text-xs px-2 py-1 rounded-full font-medium shrink-0 ${isSigned || ['Approved', 'Invoiced', 'Partially Paid', 'Paid'].includes(est.status) ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                        {isSigned && est.status === 'Invoiced' ? 'Signed' : est.status}
                                    </span>
                                </div>
                                {isSigned && (
                                    <p className="text-xs text-green-700 flex items-center gap-1 mb-2">
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        Signed by {est.approvedBy} on {new Date(est.approvedAt!).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                                    </p>
                                )}
                                <div className="flex justify-between text-sm text-hui-textMuted">
                                    <span>Total: {formatCurrency(est.totalAmount)}</span>
                                    <span>{new Date(est.createdAt).toLocaleDateString()}</span>
                                </div>
                            </Link>
                        );})}
                    </div>
                )}

                {activeTab === "schedule" && (
                    trackerData ? (
                        <PortalProjectTracker
                            projectId={projectId}
                            projectName={project.name}
                            data={trackerData}
                        />
                    ) : (
                        <div className="hui-card p-8 text-center text-sm text-hui-textMuted">
                            No schedule shared yet.
                        </div>
                    )
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
                                                                Paid{payment.paymentMethod ? ` via ${payment.paymentMethod === 'quickbooks' ? 'QuickBooks' : payment.paymentMethod.toUpperCase()}` : ''}{(payment.paidAt || payment.paymentDate) ? ` · ${new Date(payment.paidAt || payment.paymentDate).toLocaleDateString()}` : ''}
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
                                                            qbPayLink={payment.qbInvoiceLink || null}
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
                    <PortalUpdatesFeed
                        updates={updatesFeed}
                        projectColor={trackerData?.projectColor ?? project.color ?? "#4c9a2a"}
                    />
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
                    <div className="space-y-4">
                        {sharedRooms.length > 0 && (
                            <div>
                                <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500 mb-2">3D Room Designs</h3>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {sharedRooms.map((room) => (
                                        <a
                                            key={room.id}
                                            href={`/share/room/${room.shareToken}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="block hui-card overflow-hidden hover:border-blue-400 hover:shadow-md transition"
                                        >
                                            {room.thumbnail ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={room.thumbnail} alt={room.name} className="h-36 w-full object-cover bg-slate-100" />
                                            ) : (
                                                <div className="h-36 w-full bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center text-slate-400 text-sm">
                                                    3D preview
                                                </div>
                                            )}
                                            <div className="p-3">
                                                <div className="font-semibold text-slate-800 text-sm">{room.name}</div>
                                                <div className="text-xs text-slate-400 mt-0.5">Tap to explore in 3D</div>
                                            </div>
                                        </a>
                                    ))}
                                </div>
                            </div>
                        )}
                        <Link href={`/portal/projects/${projectId}/mood-boards`} className="block hui-card p-6 hover:border-indigo-500 hover:shadow-md transition text-center border-dashed">
                            <div className="w-12 h-12 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-3">
                                <svg className="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                                </svg>
                            </div>
                            <h3 className="text-base font-bold text-slate-800">View Design Concepts</h3>
                            <p className="text-sm text-slate-500 mt-1">Explore visual layouts and material choices for your space.</p>
                        </Link>
                    </div>
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
