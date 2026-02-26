import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from 'next/link';
import Avatar from "@/components/Avatar";
import StatusBadge, { StatusType } from "@/components/StatusBadge";

export default async function PortalDashboard() {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email?.toLowerCase();

    if (!email) {
        return <div className="p-8 text-center">Please log in to access your portal.</div>;
    }

    const client = await prisma.client.findFirst({
        where: { email },
        include: {
            projects: {
                orderBy: { createdAt: 'desc' },
                include: {
                    invoices: {
                        where: { status: { in: ['Issued', 'Overdue'] } },
                        select: { id: true, balanceDue: true }
                    }
                }
            }
        }
    });

    if (!client) {
        return (
            <div className="max-w-4xl mx-auto py-16 px-4 text-center">
                <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                    <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                </div>
                <h1 className="text-2xl font-bold text-slate-800 mb-2">Welcome to your Portal!</h1>
                <p className="text-slate-600 mb-6">We couldn't find any projects currently linked to <strong>{email}</strong>.</p>
                <p className="text-slate-500 text-sm">If you believe this is an error, please double-check with your project manager that this is the email address they added to your file.</p>
            </div>
        );
    }

    const projects = client.projects;

    return (
        <div className="max-w-6xl mx-auto py-8">
            <div className="flex items-center gap-4 mb-8">
                <Avatar name={client.name} color="blue" />
                <div>
                    <h1 className="text-2xl font-bold text-slate-900">Welcome back, {client.name.split(' ')[0]}!</h1>
                    <p className="text-slate-500 text-sm">Here are your active and past projects.</p>
                </div>
            </div>

            {projects.length === 0 ? (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center flex flex-col items-center">
                    <p className="text-slate-600">You don't have any projects yet. They will appear here once created by your team.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {projects.map(p => {
                        const activeInvoices = p.invoices.reduce((sum, inv) => sum + inv.balanceDue, 0);

                        return (
                            <Link href={`/portal/projects/${p.id}`} key={p.id} className="bg-white group rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition">
                                <div className="h-32 bg-slate-100 flex items-center justify-center relative overflow-hidden">
                                    <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-indigo-500/10" />
                                    <span className="text-5xl text-blue-500/20 font-bold tracking-tighter group-hover:scale-110 transition duration-500">{p.type?.[0] || 'P'}</span>
                                    {activeInvoices > 0 && (
                                        <div className="absolute top-3 right-3 bg-red-500 text-white text-xs font-bold px-2 py-1 rounded shadow-sm">
                                            Payment Due
                                        </div>
                                    )}
                                </div>
                                <div className="p-5">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-slate-900 group-hover:text-blue-600 transition truncate pr-2" title={p.name}>{p.name}</h3>
                                    </div>
                                    <div className="space-y-3 mt-4">
                                        <div className="flex items-center justify-between text-xs text-slate-500 border-b border-slate-100 pb-2">
                                            <span>Status</span>
                                            <StatusBadge status={p.status as StatusType} />
                                        </div>
                                        {p.location && (
                                            <div className="flex items-center justify-between text-xs text-slate-500">
                                                <span>Location</span>
                                                <span className="font-medium text-slate-900 truncate max-w-[150px]" title={p.location}>{p.location}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex justify-between items-center group-hover:bg-blue-50/50 transition">
                                    <span className="text-xs text-slate-500">Started {new Date(p.createdAt).toLocaleDateString()}</span>
                                    <span className="text-sm font-medium text-blue-600 group-hover:text-blue-700 flex items-center gap-1">
                                        View <svg className="w-4 h-4 transform group-hover:translate-x-1 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                    </span>
                                </div>
                            </Link>
                        )
                    })}
                </div>
            )}
        </div>
    );
}
