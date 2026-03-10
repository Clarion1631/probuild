export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = 'force-dynamic';

export default async function VarianceReportPage() {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) return redirect("/login");

    // Auth check
    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user || (user.role !== 'MANAGER' && user.role !== 'ADMIN')) {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }

    const budgets = await prisma.budget.findMany({
        include: {
            project: true,
            estimate: true,
            buckets: {
                include: {
                    timeEntries: true
                }
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
                {budgets.map((budget: any) => {
                    const totalLaborBudget = budget.totalLaborBudget || 0;

                    // Calculate actuals
                    let totalActualLabor = 0;
                    const bucketsWithActuals = budget.buckets.map((bucket: any) => {
                        const actualLabor = bucket.timeEntries.reduce((acc: number, te: any) => acc + (te.laborCost || 0) + (te.burdenCost || 0), 0);
                        totalActualLabor += actualLabor;

                        return {
                            ...bucket,
                            actualLabor,
                            variance: (bucket.laborBudget || 0) - actualLabor
                        };
                    });

                    const projectVariance = totalLaborBudget - totalActualLabor;
                    const isOverBudget = projectVariance < 0;

                    return (
                        <div key={budget.id} className="hui-card overflow-hidden">
                            <div className="p-6 border-b border-hui-border bg-slate-50 flex justify-between items-start">
                                <div>
                                    <h2 className="text-xl font-bold text-hui-textMain">{budget.project.name}</h2>
                                    <p className="text-sm text-hui-textMuted mt-1">Estimate: {budget.estimate.code} - {budget.estimate.title}</p>
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
                                        className={`h-3 \${isOverBudget ? 'bg-red-500' : 'bg-green-500'}`}
                                        style={{ width: `\${Math.min(100, (totalActualLabor / (totalLaborBudget || 1)) * 100)}%` }}
                                    ></div>
                                </div>

                                <h3 className="text-sm font-semibold uppercase tracking-wider text-hui-textMuted mb-4">Phase Breakdown</h3>
                                <div className="space-y-4">
                                    {bucketsWithActuals.map((b: any) => (
                                        <div key={b.id} className="flex items-center justify-between p-4 rounded-lg bg-slate-50 border border-hui-border">
                                            <div className="w-1/3 font-medium text-hui-textMain">{b.name}</div>
                                            <div className="w-1/4 text-sm">
                                                <div className="text-hui-textMuted">Budget</div>
                                                <div className="font-medium text-hui-textMain">${(b.laborBudget || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                            </div>
                                            <div className="w-1/4 text-sm">
                                                <div className="text-hui-textMuted">Actual (w/ Burden)</div>
                                                <div className="font-medium text-hui-textMain">${b.actualLabor.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                            </div>
                                            <div className={`w-1/4 text-sm text-right font-bold ${b.variance < 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                {b.variance < 0 ? '-' : '+'}${Math.abs(b.variance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                            </div>
                                        </div>
                                    ))}
                                    {bucketsWithActuals.length === 0 && (
                                        <div className="text-sm text-hui-textMuted italic">No phases found for this budget.</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {budgets.length === 0 && (
                    <div className="text-center py-12 text-hui-textMuted hui-card border-dashed">
                        No budgets found automatically generated from approved estimates.
                    </div>
                )}
            </div>
        </div>
    );
}
