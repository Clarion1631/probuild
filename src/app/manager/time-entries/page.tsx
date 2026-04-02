export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function ManagerTimeEntriesPage() {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) return redirect("/login");

    // Auth check
    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }

    const entries = await prisma.timeEntry.findMany({
        include: {
            user: true,
            project: true,
            costCode: true,
            costType: true
        },
        orderBy: { startTime: 'desc' },
        take: 100
    });

    const totalDuration = entries.reduce((acc: number, e: any) => acc + (e.durationHours || 0), 0);
    const totalCost = entries.reduce((acc: number, e: any) => acc + (e.laborCost || 0) + (e.burdenCost || 0), 0);
    const totalBillable = 0;
    const totalInvoiced = 0;

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-8">
            <div className="flex justify-between items-center">
                <h1 className="text-2xl font-bold text-hui-textMain">Time Entries Audit</h1>
                <Link href="/manager/variance" className="hui-btn hui-btn-primary">
                    View Variance Report
                </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="hui-card p-6 border-l-[3px] border-l-blue-500">
                    <div className="text-sm font-medium text-hui-textMuted mb-2">Total Duration</div>
                    <div className="text-2xl font-bold text-hui-textMain">{totalDuration.toFixed(2)}h</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-orange-500">
                    <div className="text-sm font-medium text-hui-textMuted mb-2">Total Billable</div>
                    <div className="text-2xl font-bold text-hui-textMain">${totalBillable.toFixed(2)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-cyan-500">
                    <div className="text-sm font-medium text-hui-textMuted mb-2">Total Invoiced</div>
                    <div className="text-2xl font-bold text-hui-textMain">${totalInvoiced.toFixed(2)}</div>
                </div>
                <div className="hui-card p-6 border-l-[3px] border-l-pink-500">
                    <div className="text-sm font-medium text-hui-textMuted mb-2">Total Cost</div>
                    <div className="text-2xl font-bold text-hui-textMain">${totalCost.toFixed(2)}</div>
                </div>
            </div>

            <div className="hui-card overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 border-b border-hui-border text-hui-textMuted">
                        <tr>
                            <th className="px-6 py-4 font-medium">Employee</th>
                            <th className="px-6 py-4 font-medium">Project - Phase</th>
                            <th className="px-6 py-4 font-medium">Time</th>
                            <th className="px-6 py-4 font-medium text-center">Duration (Hrs)</th>
                            <th className="px-6 py-4 font-medium">Costs</th>
                            <th className="px-6 py-4 font-medium">Location</th>
                            <th className="px-6 py-4 font-medium">Audit</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hui-border">
                        {entries.map((e: any) => (
                            <tr key={e.id} className="hover:bg-slate-50">
                                <td className="px-6 py-4 font-medium text-hui-textMain">
                                    {e.user.name || e.user.email}
                                </td>
                                <td className="px-6 py-4 text-hui-textMuted">
                                    <div className="font-medium text-hui-textMain">{e.project.name}</div>
                                    <div className="text-xs text-hui-textMuted">{e.costCode?.name || "No Code"}</div>
                                </td>
                                <td className="px-6 py-4 text-hui-textMuted">
                                    <div className="whitespace-nowrap">{new Date(e.startTime).toLocaleString()}</div>
                                    <div className="text-hui-textMuted text-xs">
                                        to {e.endTime ? new Date(e.endTime).toLocaleString() : 'Active'}
                                    </div>
                                </td>
                                <td className="px-6 py-4 text-hui-textMain font-medium text-center">
                                    {e.durationHours ? e.durationHours.toFixed(2) : '-'}
                                </td>
                                <td className="px-6 py-4 text-xs">
                                    <div className="text-hui-textMuted">Labor: ${e.laborCost?.toFixed(2) || '0.00'}</div>
                                    <div className="text-hui-textMuted">Burden: ${e.burdenCost?.toFixed(2) || '0.00'}</div>
                                </td>
                                <td className="px-6 py-4 text-xs text-hui-textMuted">
                                    {e.latitude && e.longitude ? (
                                        <a href={`https://maps.google.com/?q=${e.latitude},${e.longitude}`} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
                                            {e.latitude.toFixed(4)},<br />{e.longitude.toFixed(4)}
                                        </a>
                                    ) : '-'}
                                </td>
                                <td className="px-6 py-4 text-xs text-hui-textMuted">
                                    {e.editedByManagerId ? (
                                        <span className="text-amber-700 bg-amber-50 px-2 py-1 rounded inline-block border border-amber-200">
                                            Edited by Manager
                                        </span>
                                    ) : (
                                        <span className="text-hui-textMuted">Original</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {entries.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-6 py-12 text-center text-hui-textMuted">
                                    No time entries found.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
