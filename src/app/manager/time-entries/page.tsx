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
            budgetBucket: true
        },
        orderBy: { startTime: 'desc' },
        take: 100 // Limit for display
    });

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-8">
            <div className="flex justify-between items-center">
                <h1 className="text-3xl font-bold">Time Entries Audit</h1>
                <Link href="/manager/variance" className="px-4 py-2 bg-slate-900 text-white rounded shadow text-sm font-medium hover:bg-slate-800 transition">
                    View Variance Report
                </Link>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
                        <tr>
                            <th className="px-6 py-4 font-medium">Employee</th>
                            <th className="px-6 py-4 font-medium">Project - Phase</th>
                            <th className="px-6 py-4 font-medium">Time</th>
                            <th className="px-6 py-4 font-medium">Duration (Hrs)</th>
                            <th className="px-6 py-4 font-medium">Costs</th>
                            <th className="px-6 py-4 font-medium">Location</th>
                            <th className="px-6 py-4 font-medium">Audit</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {entries.map((e: any) => (
                            <tr key={e.id} className="hover:bg-slate-50">
                                <td className="px-6 py-4 font-medium text-slate-900">
                                    {e.user.name || e.user.email}
                                </td>
                                <td className="px-6 py-4 text-slate-600">
                                    <div className="font-medium text-slate-800">{e.project.name}</div>
                                    <div className="text-xs text-slate-500">{e.budgetBucket?.name || "No Phase"}</div>
                                </td>
                                <td className="px-6 py-4 text-slate-600">
                                    <div className="whitespace-nowrap">{new Date(e.startTime).toLocaleString()}</div>
                                    <div className="text-slate-400 text-xs">
                                        to {e.endTime ? new Date(e.endTime).toLocaleString() : 'Active'}
                                    </div>
                                </td>
                                <td className="px-6 py-4 text-slate-800 font-medium text-center">
                                    {e.durationHours ? e.durationHours.toFixed(2) : '-'}
                                </td>
                                <td className="px-6 py-4 text-xs">
                                    <div className="text-slate-600">Labor: ${e.laborCost?.toFixed(2) || '0.00'}</div>
                                    <div className="text-slate-400">Burden: ${e.burdenCost?.toFixed(2) || '0.00'}</div>
                                </td>
                                <td className="px-6 py-4 text-xs text-slate-500">
                                    {e.latitude && e.longitude ? (
                                        <a href={`https://maps.google.com/?q=${e.latitude},${e.longitude}`} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
                                            {e.latitude.toFixed(4)},<br />{e.longitude.toFixed(4)}
                                        </a>
                                    ) : '-'}
                                </td>
                                <td className="px-6 py-4 text-xs text-slate-500">
                                    {e.editedByManagerId ? (
                                        <span className="text-amber-700 bg-amber-50 px-2 py-1 rounded inline-block border border-amber-200">
                                            Edited by Manager
                                        </span>
                                    ) : (
                                        <span className="text-slate-400">Original</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {entries.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
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
