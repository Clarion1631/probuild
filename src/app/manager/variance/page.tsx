import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = 'force-dynamic';

export default async function VarianceReportPage() {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }

    // Get all projects with their time entries grouped by cost code
    const projects = await prisma.project.findMany({
        where: { status: "In Progress" },
        include: {
            estimates: {
                include: {
                    items: {
                        include: { costCode: true, costType: true }
                    }
                }
            },
            timeEntries: {
                include: { costCode: true, user: true }
            }
        },
        orderBy: { createdAt: 'desc' }
    });

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-8">
            <div className="flex justify-between items-center">
                <h1 className="text-2xl font-bold text-hui-textMain">Project Variance Report</h1>
                <Link href="/manager/time-entries" className="hui-btn hui-btn-primary">
                    View Time Entries Audit
                </Link>
            </div>

            <div className="space-y-8">
                {projects.map((project: any) => {
                    // Build cost code budget from estimate items
                    const costCodeBudgets: Record<string, { code: string; name: string; laborBudget: number; materialBudget: number; actualLabor: number }> = {};
                    
                    for (const estimate of project.estimates) {
                        for (const item of estimate.items) {
                            const ccId = item.costCodeId || '__uncategorized';
                            if (!costCodeBudgets[ccId]) {
                                costCodeBudgets[ccId] = {
                                    code: item.costCode?.code || 'N/A',
                                    name: item.costCode?.name || 'Uncategorized',
                                    laborBudget: 0,
                                    materialBudget: 0,
                                    actualLabor: 0,
                                };
                            }
                            const itemCategory = item.costType?.name || item.type || "";
                            if (itemCategory === 'Labor') {
                                costCodeBudgets[ccId].laborBudget += item.total || 0;
                            } else {
                                costCodeBudgets[ccId].materialBudget += item.total || 0;
                            }
                        }
                    }

                    // Add actuals from time entries
                    for (const te of project.timeEntries) {
                        const ccId = te.costCodeId || '__uncategorized';
                        if (!costCodeBudgets[ccId]) {
                            costCodeBudgets[ccId] = {
                                code: te.costCode?.code || 'N/A',
                                name: te.costCode?.name || 'Uncategorized',
                                laborBudget: 0,
                                materialBudget: 0,
                                actualLabor: 0,
                            };
                        }
                        costCodeBudgets[ccId].actualLabor += (te.laborCost || 0) + (te.burdenCost || 0);
                    }

                    const phases = Object.values(costCodeBudgets);
                    const totalLaborBudget = phases.reduce((acc, p) => acc + p.laborBudget, 0);
                    const totalActualLabor = phases.reduce((acc, p) => acc + p.actualLabor, 0);
                    const projectVariance = totalLaborBudget - totalActualLabor;
                    const isOverBudget = projectVariance < 0;

                    if (phases.length === 0) return null;

                    return (
                        <div key={project.id} className="hui-card overflow-hidden">
                            <div className="p-6 border-b border-hui-border bg-slate-50 flex justify-between items-start">
                                <div>
                                    <h2 className="text-xl font-bold text-hui-textMain">{project.name}</h2>
                                    <p className="text-sm text-hui-textMuted mt-1">
                                        {project.estimates.length} estimate(s) • {project.timeEntries.length} time entries
                                    </p>
                                </div>
                                <div className="text-right">
                                    <div className="text-sm text-hui-textMuted mb-1">Total Labor Variance</div>
                                    <div className={`text-xl font-bold ${isOverBudget ? 'text-red-600' : 'text-green-600'}`}>
                                        {isOverBudget ? '-' : '+'}${Math.abs(projectVariance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </div>
                                </div>
                            </div>

                            <div className="p-6">
                                <div className="flex justify-between text-sm mb-2">
                                    <span className="font-medium text-hui-textMain">Budgeted Labor: ${totalLaborBudget.toLocaleString()}</span>
                                    <span className="font-medium text-hui-textMain">Actual Labor + Burden: ${totalActualLabor.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                                <div className="w-full bg-slate-100 rounded-full h-3 mb-8 overflow-hidden flex">
                                    <div
                                        className={`h-3 ${isOverBudget ? 'bg-red-500' : 'bg-green-500'}`}
                                        style={{ width: `${Math.min(100, (totalActualLabor / (totalLaborBudget || 1)) * 100)}%` }}
                                    ></div>
                                </div>

                                <h3 className="text-sm font-semibold uppercase tracking-wider text-hui-textMuted mb-4">Phase Breakdown (by Cost Code)</h3>
                                <div className="space-y-4">
                                    {phases.map((phase, idx) => {
                                        const variance = phase.laborBudget - phase.actualLabor;
                                        return (
                                            <div key={idx} className="flex items-center justify-between p-4 rounded-lg bg-slate-50 border border-hui-border">
                                                <div className="w-1/3">
                                                    <span className="font-mono text-xs text-slate-500 mr-2">{phase.code}</span>
                                                    <span className="font-medium text-hui-textMain">{phase.name}</span>
                                                </div>
                                                <div className="w-1/4 text-sm">
                                                    <div className="text-hui-textMuted">Budget</div>
                                                    <div className="font-medium text-hui-textMain">${phase.laborBudget.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                                </div>
                                                <div className="w-1/4 text-sm">
                                                    <div className="text-hui-textMuted">Actual (w/ Burden)</div>
                                                    <div className="font-medium text-hui-textMain">${phase.actualLabor.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                                </div>
                                                <div className={`w-1/4 text-sm text-right font-bold ${variance < 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                    {variance < 0 ? '-' : '+'}${Math.abs(variance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {phases.length === 0 && (
                                        <div className="text-sm text-hui-textMuted italic">No cost codes assigned yet.</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {projects.length === 0 && (
                    <div className="text-center py-12 text-hui-textMuted hui-card border-dashed">
                        No active projects found.
                    </div>
                )}
            </div>
        </div>
    );
}
