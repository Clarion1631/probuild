import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from 'next/link';
import { notFound } from "next/navigation";
import StatusBadge, { StatusType } from "@/components/StatusBadge";
import PortalPayButton from "@/components/PortalPayButton";
import { getPortalVisibility } from "@/lib/actions";
import { formatCurrency } from "@/lib/utils";

export default async function PortalProjectDetail(props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    const projectId = params.id;
    
    // Auth-less access: URL provides the capability, no session required
    // We just fetch the project and its related data
    const project = await prisma.project.findFirst({
        where: { id: projectId },
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
                    payments: {
                        orderBy: { createdAt: 'asc' }
                    }
                }
            },
            changeOrders: {
                where: { status: { not: 'Draft' } },
                orderBy: { createdAt: 'desc' },
                include: { estimate: { select: { id: true, code: true, title: true, status: true, totalAmount: true } } }
            },
            floorPlans: {
                orderBy: { createdAt: 'desc' }
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


    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const visibility = await getPortalVisibility(projectId);

    if (!project) return notFound();

    const clientName = project.client?.name || "Client";
    const clientEmail = project.client?.email || "";

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

    return (
        <div className="max-w-5xl mx-auto py-8">
            <div className="mb-6">
                <Link href="/portal" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm w-fit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back to Dashboard
                </Link>
            </div>

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
                    <StatusBadge status={project.status as StatusType} />
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Estimates Section */}
                {visibility.showEstimates && (
                <div>
                    <h2 className="text-xl font-bold text-hui-textMain mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-hui-textMuted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        Estimates &amp; Proposals
                    </h2>
                    {project.estimates.length === 0 ? (
                        <div className="bg-hui-background border border-hui-border rounded-lg p-6 text-center text-hui-textMuted text-sm">
                            No shared estimates available yet.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {project.estimates.map(est => (
                                <Link href={`/portal/estimates/${est.id}`} key={est.id} className="block hui-card p-4 hover:border-blue-300 hover:shadow-sm transition">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-hui-textMain truncate pr-2">{est.title}</h3>
                                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${est.status === 'Approved' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
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
                </div>
                )}

                {/* Schedule Section */}
                {visibility.showSchedule && (
                <div className="md:col-span-2">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-hui-textMain flex items-center gap-2">
                            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                            Project Schedule
                        </h2>
                        <Link href={`/portal/projects/${projectId}/schedule`} className="text-sm font-semibold text-blue-500 hover:text-blue-700 transition">
                            View Timeline →
                        </Link>
                    </div>
                    <Link href={`/portal/projects/${projectId}/schedule`} className="block hui-card p-6 hover:border-blue-500 hover:shadow-md transition text-center border-dashed">
                        <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-3">
                            <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                        </div>
                        <h3 className="text-base font-bold text-slate-800">View Project Timeline</h3>
                        <p className="text-sm text-slate-500 mt-1">Check the sequence of tasks and overall progress.</p>
                    </Link>
                </div>
                )}

                {/* Change Orders Section */}
                <div>
                    <h2 className="text-xl font-bold text-hui-textMain mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                        Change Orders
                    </h2>
                    {(project.changeOrders || []).length === 0 ? (
                        <div className="bg-hui-background border border-hui-border rounded-lg p-6 text-center text-hui-textMuted text-sm">
                            No active Change Orders for this project.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {project.changeOrders.map((co: any) => (
                                <Link href={`/portal/change-orders/${co.id}`} key={co.id} className="block hui-card p-4 hover:border-amber-300 hover:shadow-sm transition">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-hui-textMain truncate pr-2">{co.title}</h3>
                                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${co.status === 'Approved' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
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

                {/* Invoices Section */}
                {visibility.showInvoices && (
                <div>
                    <h2 className="text-xl font-bold text-hui-textMain mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-hui-textMuted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
                        Invoices
                    </h2>
                    {project.invoices.length === 0 ? (
                        <div className="bg-hui-background border border-hui-border rounded-lg p-6 text-center text-hui-textMuted text-sm">
                            No invoices available yet.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {project.invoices.map(inv => (
                                <div key={inv.id} className="block hui-card p-4">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-hui-textMain">Invoice #{inv.code}</h3>
                                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${inv.status === 'Paid' ? 'bg-green-100 text-green-700' :
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
                                                                amount={payment.amount}
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
                </div>
                )}

                {/* Floor Plans Section */}
                {visibility.showFiles && (
                <div className="md:col-span-2 mt-4">
                    <h2 className="text-xl font-bold text-hui-textMain mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-hui-textMuted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /></svg>
                        3D Floor Plans &amp; Designs
                    </h2>
                    {project.floorPlans.length === 0 ? (
                        <div className="bg-hui-background border border-hui-border rounded-lg p-6 text-center text-hui-textMuted text-sm">
                            No 3D floor plans available yet.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {project.floorPlans.map(plan => (
                                <div key={plan.id} className="block hui-card overflow-hidden group">
                                    <div className="h-32 bg-slate-100 relative overflow-hidden flex items-center justify-center">
                                        <div className="absolute inset-0 bg-gradient-to-br from-slate-200 to-slate-100" />
                                        <svg className="w-10 h-10 text-slate-300 relative z-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" /></svg>
                                    </div>
                                    <div className="p-4 flex justify-between items-center">
                                        <h3 className="font-semibold text-hui-textMain truncate">{plan.name}</h3>
                                        <span className="text-xs text-hui-textMuted">{new Date(plan.createdAt).toLocaleDateString()}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                )}

                {/* Daily Logs Section */}
                {visibility.showDailyLogs && (
                <div className="md:col-span-2 mt-4">
                    <h2 className="text-xl font-bold text-hui-textMain mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        Daily Logs
                    </h2>
                    {(!project.dailyLogs || project.dailyLogs.length === 0) ? (
                        <div className="bg-hui-background border border-hui-border rounded-lg p-6 text-center text-hui-textMuted text-sm">
                            No daily logs have been published yet.
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {project.dailyLogs.map((log: any) => (
                                <div key={log.id} className="hui-card p-5 border-l-4 border-l-purple-500">
                                    <div className="flex items-start justify-between mb-3 border-b border-slate-100 pb-3">
                                        <div>
                                            <h3 className="font-bold text-hui-textMain text-lg">
                                                {new Date(log.date).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
                                            </h3>
                                            <p className="text-xs text-hui-textMuted mt-1">
                                                Logged by {log.createdBy.name || log.createdBy.email}
                                            </p>
                                        </div>
                                        {/* Badges */}
                                        <div className="flex items-center gap-2 flex-wrap justify-end">
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
                </div>
                )}

                {/* Selections / Mood Boards Section */}
                {visibility.showSelections && (
                <div className="md:col-span-2 mt-4">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-hui-textMain flex items-center gap-2">
                            <svg className="w-5 h-5 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            Selections
                        </h2>
                        <Link href={`/portal/projects/${projectId}/selections`} className="text-sm font-semibold text-hui-primary hover:text-hui-primaryHover transition">
                            View All →
                        </Link>
                    </div>
                    <Link href={`/portal/projects/${projectId}/selections`} className="block hui-card p-6 hover:border-hui-primary hover:shadow-md transition text-center border-dashed">
                        <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-3">
                            <svg className="w-6 h-6 text-hui-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                        </div>
                        <h3 className="text-base font-bold text-slate-800">Review Project Selections</h3>
                        <p className="text-sm text-slate-500 mt-1">Make your choices for finishes, materials, and fixtures.</p>
                    </Link>
                </div>
                )}

                {/* Mood Boards Section */}
                {visibility.showMoodBoards && (
                <div className="md:col-span-2 mt-4">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-hui-textMain flex items-center gap-2">
                            <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            Visual Mood Boards
                        </h2>
                        <Link href={`/portal/projects/${projectId}/mood-boards`} className="text-sm font-semibold text-indigo-500 hover:text-indigo-700 transition">
                            View All →
                        </Link>
                    </div>
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

            </div>
        </div>
    );
}
