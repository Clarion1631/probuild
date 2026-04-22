export const dynamic = "force-dynamic";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionClientId } from "@/lib/portal-auth";
import Link from 'next/link';
import Avatar from "@/components/Avatar";
import StatusBadge, { StatusType } from "@/components/StatusBadge";

export default async function PortalDashboard() {
    const staffSession = await getServerSession(authOptions);
    const isStaff = ["ADMIN", "MANAGER"].includes((staffSession?.user as any)?.role);

    let projects: any[] = [];
    let clientContracts: any[] = [];
    let clientName = "Team";

    if (isStaff) {
        const allProjects = await prisma.project.findMany({
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: {
                client: { select: { name: true } },
                invoices: {
                    where: { status: { in: ['Issued', 'Overdue', 'Partially Paid'] } },
                    select: { id: true, balanceDue: true }
                }
            }
        });
        projects = allProjects;

        clientContracts = await prisma.contract.findMany({
            where: { status: { in: ["Sent", "Viewed", "Signed", "Finalized"] } },
            select: {
                id: true, title: true, status: true, sentAt: true, approvedAt: true,
                lead: { select: { name: true } }, project: { select: { name: true } },
            },
            orderBy: { sentAt: "desc" },
            take: 20,
        });
    } else {
        const sessionClientId = await resolveSessionClientId();

        if (!sessionClientId) {
            const email = staffSession?.user?.email?.toLowerCase();
            return (
                <div className="max-w-4xl mx-auto py-16 px-4 text-center">
                    <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                        <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    </div>
                    <h1 className="text-2xl font-bold text-hui-textMain mb-2">Welcome to your Portal!</h1>
                    <p className="text-hui-textMuted mb-6">
                        {email
                            ? <>We couldn&apos;t find any projects currently linked to <strong>{email}</strong>.</>
                            : "Please use the link from your email to access your portal."
                        }
                    </p>
                    <p className="text-hui-textMuted text-sm">If you believe this is an error, please double-check with your project manager that this is the email address they added to your file.</p>
                </div>
            );
        }

        const client = await prisma.client.findUnique({
            where: { id: sessionClientId },
            include: {
                projects: {
                    orderBy: { createdAt: 'desc' },
                    include: {
                        invoices: {
                            where: { status: { in: ['Issued', 'Overdue', 'Partially Paid'] } },
                            select: { id: true, balanceDue: true }
                        }
                    }
                }
            }
        });

        clientContracts = await prisma.contract.findMany({
            where: {
                status: { in: ["Sent", "Viewed", "Signed", "Finalized"] },
                OR: [
                    { lead: { clientId: sessionClientId } },
                    { project: { clientId: sessionClientId } },
                ],
            },
            select: {
                id: true, title: true, status: true, sentAt: true, approvedAt: true,
                accessToken: true, lead: { select: { name: true } }, project: { select: { name: true } },
            },
            orderBy: { sentAt: "desc" },
        });

        if (!client) {
            return (
                <div className="max-w-4xl mx-auto py-16 px-4 text-center">
                    <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                        <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    </div>
                    <h1 className="text-2xl font-bold text-hui-textMain mb-2">Welcome to your Portal!</h1>
                    <p className="text-hui-textMuted mb-6">We couldn&apos;t find any projects linked to your account.</p>
                    <p className="text-hui-textMuted text-sm">If you believe this is an error, please double-check with your project manager that this is the email address they added to your file.</p>
                </div>
            );
        }

        projects = client.projects;
        clientName = client.name;
    }

    return (
        <div className="max-w-6xl mx-auto py-8">
            {isStaff && (
                <div className="mb-4 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    Staff Preview — viewing all client projects
                </div>
            )}
            <div className="flex items-center gap-4 mb-8">
                <Avatar name={clientName} color="blue" />
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">{isStaff ? "Portal Staff Preview" : `Welcome back, ${clientName.split(' ')[0]}!`}</h1>
                    <p className="text-hui-textMuted text-sm">{isStaff ? "Browse all client projects and documents." : "Here are your active and past projects."}</p>
                </div>
            </div>

            {projects.length === 0 && clientContracts.length === 0 ? (
                <div className="hui-card p-8 text-center flex flex-col items-center">
                    <p className="text-hui-textMuted">You don't have any projects yet. They will appear here once created by your team.</p>
                </div>
            ) : projects.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {projects.map(p => {
                        const activeInvoices = (p.invoices || []).reduce((sum: number, inv: any) => sum + Number(inv.balanceDue), 0);

                        return (
                            <Link href={`/portal/projects/${p.id}`} key={p.id} className="hui-card group overflow-hidden hover:shadow-md transition flex flex-col">
                                <div className="h-32 bg-slate-100 flex items-center justify-center relative overflow-hidden">
                                    <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-indigo-500/10" />
                                    <span className="text-5xl text-blue-500/20 font-bold tracking-tighter group-hover:scale-110 transition duration-500">{p.type?.[0] || 'P'}</span>
                                    {activeInvoices > 0 && (
                                        <div className="absolute top-3 right-3 bg-red-500 text-white text-xs font-bold px-2 py-1 rounded shadow-sm">
                                            Payment Due
                                        </div>
                                    )}
                                </div>
                                <div className="p-5 flex-1">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-hui-textMain group-hover:text-blue-600 transition truncate pr-2" title={p.name}>{p.name}</h3>
                                    </div>
                                    <div className="space-y-3 mt-4">
                                        {isStaff && p.client?.name && (
                                            <div className="flex items-center justify-between text-xs text-hui-textMuted border-b border-hui-border pb-2">
                                                <span>Client</span>
                                                <span className="font-medium text-hui-textMain truncate max-w-[150px]">{p.client.name}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between text-xs text-hui-textMuted border-b border-hui-border pb-2">
                                            <span>Status</span>
                                            <StatusBadge status={p.status as StatusType} />
                                        </div>
                                        {p.location && (
                                            <div className="flex items-center justify-between text-xs text-hui-textMuted">
                                                <span>Location</span>
                                                <span className="font-medium text-hui-textMain truncate max-w-[150px]" title={p.location}>{p.location}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="px-5 py-3 border-t border-hui-border bg-slate-50/50 flex justify-between items-center group-hover:bg-blue-50/50 transition mt-auto">
                                    <span className="text-xs text-hui-textMuted">Started {new Date(p.createdAt).toLocaleDateString()}</span>
                                    <span className="text-sm font-medium text-blue-600 group-hover:text-blue-700 flex items-center gap-1">
                                        View <svg className="w-4 h-4 transform group-hover:translate-x-1 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                    </span>
                                </div>
                            </Link>
                        )
                    })}
                </div>
            )}

            {clientContracts.length > 0 && (
                <div className="mt-12">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold text-hui-textMain">Documents</h2>
                        <span className="text-xs text-hui-textMuted">{clientContracts.length} total</span>
                    </div>
                    <div className="hui-card divide-y divide-hui-border overflow-hidden">
                        {clientContracts.map((c: any) => {
                            const context = c.project?.name || c.lead?.name || "";
                            const href = (!isStaff && c.accessToken)
                                ? `/portal/contracts/${c.id}?token=${c.accessToken}`
                                : `/portal/contracts/${c.id}`;
                            const isSigned = c.status === "Signed" || c.status === "Finalized";
                            return (
                                <Link
                                    key={c.id}
                                    href={href}
                                    className="flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition group"
                                >
                                    <div className="flex items-center gap-4 min-w-0 flex-1">
                                        <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                                            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 mb-1">
                                                <h3 className="font-medium text-hui-textMain truncate group-hover:text-blue-600 transition">
                                                    {c.title}
                                                </h3>
                                                <StatusBadge status={c.status as StatusType} />
                                            </div>
                                            <div className="flex items-center gap-3 text-xs text-hui-textMuted">
                                                {context && <span className="truncate">{context}</span>}
                                                {c.sentAt && (
                                                    <span>· Sent {new Date(c.sentAt).toLocaleDateString()}</span>
                                                )}
                                                {isSigned && c.approvedAt && (
                                                    <span className="text-green-600 font-medium">
                                                        · Signed {new Date(c.approvedAt).toLocaleDateString()}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 text-sm text-blue-600 font-medium flex-shrink-0 ml-4">
                                        {isSigned ? "View & Download" : "Review"}
                                        <svg className="w-4 h-4 transform group-hover:translate-x-1 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                        </svg>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
