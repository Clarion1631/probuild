import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from 'next/link';
import { notFound } from "next/navigation";
import StatusBadge, { StatusType } from "@/components/StatusBadge";

export default async function PortalProjectDetail(props: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email?.toLowerCase();

    if (!email) {
        return <div className="p-8 text-center">Please log in to access your portal.</div>;
    }

    const params = await props.params;
    const projectId = params.id;

    // Fetch the project BUT ensure it belongs to the logged-in client's email
    const project = await prisma.project.findFirst({
        where: {
            id: projectId,
            client: { email }
        },
        include: {
            client: true,
            estimates: {
                where: {
                    privacy: 'Shared',
                    status: { not: 'Draft' } // Show Sent, Approved, Invoiced, etc.
                },
                orderBy: { createdAt: 'desc' }
            },
            invoices: {
                where: { status: { not: 'Draft' } },
                orderBy: { issueDate: 'desc' }
            },
            floorPlans: {
                orderBy: { createdAt: 'desc' }
            }
        }
    });

    if (!project) return notFound();

    return (
        <div className="max-w-5xl mx-auto py-8">
            <div className="mb-6">
                <Link href="/portal" className="text-sm text-blue-600 hover:text-blue-800 transition flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back to Dashboard
                </Link>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 mb-8">
                <div className="flex justify-between items-start">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900 mb-2">{project.name}</h1>
                        <div className="flex gap-4 text-sm text-slate-500">
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
                <div>
                    <h2 className="text-xl font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        Estimates & Proposals
                    </h2>
                    {project.estimates.length === 0 ? (
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center text-slate-500 text-sm">
                            No shared estimates available yet.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {project.estimates.map(est => (
                                <Link href={`/portal/estimates/${est.id}`} key={est.id} className="block bg-white border border-slate-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-slate-900 truncate pr-2">{est.title}</h3>
                                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${est.status === 'Approved' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                            {est.status}
                                        </span>
                                    </div>
                                    <div className="flex justify-between text-sm text-slate-500">
                                        <span>Total: ${(est.totalAmount || 0).toLocaleString()}</span>
                                        <span>{new Date(est.createdAt).toLocaleDateString()}</span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    )}
                </div>

                {/* Invoices Section */}
                <div>
                    <h2 className="text-xl font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
                        Invoices
                    </h2>
                    {project.invoices.length === 0 ? (
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center text-slate-500 text-sm">
                            No invoices available yet.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {project.invoices.map(inv => (
                                <div key={inv.id} className="block bg-white border border-slate-200 rounded-lg p-4">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-slate-900">Invoice #{inv.code}</h3>
                                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${inv.status === 'Paid' ? 'bg-green-100 text-green-700' :
                                                inv.status === 'Overdue' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-800'
                                            }`}>
                                            {inv.status}
                                        </span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-slate-500">Amount: ${(inv.totalAmount || 0).toLocaleString()}</span>
                                        <span className="font-medium text-slate-900">Due: ${(inv.balanceDue || 0).toLocaleString()}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Floor Plans Section */}
                <div className="md:col-span-2 mt-4">
                    <h2 className="text-xl font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /></svg>
                        3D Floor Plans & Designs
                    </h2>
                    {project.floorPlans.length === 0 ? (
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center text-slate-500 text-sm">
                            No 3D floor plans available yet.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {project.floorPlans.map(plan => (
                                <div key={plan.id} className="block bg-white border border-slate-200 rounded-lg overflow-hidden group">
                                    <div className="h-32 bg-slate-100 relative overflow-hidden flex items-center justify-center">
                                        <div className="absolute inset-0 bg-gradient-to-br from-slate-200 to-slate-100" />
                                        <svg className="w-10 h-10 text-slate-300 relative z-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" /></svg>
                                    </div>
                                    <div className="p-4 flex justify-between items-center">
                                        <h3 className="font-semibold text-slate-900 truncate">{plan.name}</h3>
                                        <span className="text-xs text-slate-500">{new Date(plan.createdAt).toLocaleDateString()}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
}
