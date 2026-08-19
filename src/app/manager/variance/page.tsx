import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import { loadProjectVariance } from "@/lib/job-variance-db";
import type { PhaseVariance, ProjectVariance } from "@/lib/job-variance";

export const dynamic = "force-dynamic";

/**
 * Job-cost variance — estimated vs actual, per phase and per estimate item.
 *
 * Rebuilt 2026-08-19. The previous version summed ONLY time-entry labor and did
 * not query expenses at all, so materials and subcontractors — most of the cost
 * of a remodel — read as $0 and every job showed a large favourable variance.
 * The rules now live in src/lib/job-variance.ts and are unit-tested.
 *
 * TRUST rule: every number here ships with the share of actual dollars that
 * could not be attributed to a phase. A tidy variance computed on 41% of the
 * money is not a result, and this page must never let it look like one.
 */

function VarianceAmount({ value, className = "" }: { value: number; className?: string }) {
    // Negative variance = over budget. Colour and sign must agree, always.
    const over = value < 0;
    return (
        <span className={`font-bold ${over ? "text-red-600" : "text-green-600"} ${className}`}>
            {over ? "−" : "+"}
            {formatCurrency(Math.abs(value))}
        </span>
    );
}

function TrustBar({ variance }: { variance: ProjectVariance }) {
    // Math.floor, not round: peer-review finding — rounding UP let 99.6% render
    // as "100% attributed / Trustworthy" while hundreds of dollars were genuinely
    // unplaced. Coverage must never flatter itself into the trustworthy band.
    const pct = Math.floor(variance.coverage.attributedShare * 100);
    const tone =
        pct >= 90 ? { bar: "bg-green-500", text: "text-green-700", label: "Trustworthy" }
        : pct >= 60 ? { bar: "bg-amber-500", text: "text-amber-700", label: "Partial — read with care" }
        : { bar: "bg-red-500", text: "text-red-700", label: "Too little data to trust" };

    return (
        <div className="rounded-lg border border-hui-border bg-slate-50 p-4">
            <div className="flex items-baseline justify-between mb-2">
                <span className="text-sm font-semibold text-hui-textMain">
                    Data coverage: <span className={tone.text}>{pct}% attributed</span>
                </span>
                <span className={`text-xs font-medium ${tone.text}`}>{tone.label}</span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden mb-3">
                <div className={`h-2 ${tone.bar}`} style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-hui-textMuted">
                <div>
                    <span className="block font-medium text-hui-textMain">
                        {formatCurrency(variance.coverage.unattributedTotal)}
                    </span>
                    spent with no phase — invisible below
                    {/* Netting can hide activity: a charge and an equal refund cancel to
                        $0 while coverage still (correctly) reads 0%. Show the gross so
                        the bar and the dollar figure can never contradict each other. */}
                    {Math.abs(variance.coverage.unattributedGross - variance.coverage.unattributedTotal) > 0.005 && (
                        <span className="block text-hui-textMuted">
                            ({formatCurrency(variance.coverage.unattributedGross)} gross, before refunds)
                        </span>
                    )}
                </div>
                <div>
                    <span className="block font-medium text-hui-textMain">
                        {formatCurrency(variance.coverage.phaseOnlyActuals)}
                    </span>
                    on a phase but no line item
                </div>
                <div>
                    <span className="block font-medium text-hui-textMain">
                        {formatCurrency(variance.uncodedBudget)}
                    </span>
                    budget on uncoded items
                </div>
            </div>
            {variance.coverage.malformedRows > 0 && (
                // Surfaced rather than silently zeroed — a corrupt amount is a
                // data problem someone must fix, not $0 of spend.
                <div className="mt-3 text-xs font-medium text-red-700">
                    ⚠ {variance.coverage.malformedRows} row(s) had an unreadable amount and are
                    excluded from every figure above. Check the source data.
                </div>
            )}
        </div>
    );
}

function PhaseRow({ phase }: { phase: PhaseVariance }) {
    const pct = phase.percentUsed;
    const over = phase.variance < 0;
    // A phase with actuals and no budget is 100% overrun by definition.
    const barWidth = pct === null ? (phase.totalActual > 0 ? 100 : 0) : Math.min(100, pct * 100);

    return (
        <div className="p-4 rounded-lg bg-white border border-hui-border">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                <div className="min-w-0">
                    <span className="font-mono text-xs text-slate-500 mr-2">{phase.code}</span>
                    <span className="font-medium text-hui-textMain">{phase.name}</span>
                    {phase.totalBudget === 0 && phase.totalActual > 0 && (
                        <span className="ml-2 text-xs font-medium text-red-600">not in the estimate</span>
                    )}
                    {phase.hasNegativeBudget && (
                        // Without this the "% used" line and the "not in the
                        // estimate" warning both vanish with no explanation.
                        <span className="ml-2 text-xs font-medium text-amber-600">
                            negative budget — check the estimate
                        </span>
                    )}
                </div>
                <VarianceAmount value={phase.variance} />
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-hui-textMuted mb-2">
                <span>Budget <span className="text-hui-textMain font-medium">{formatCurrency(phase.totalBudget)}</span></span>
                <span>Actual <span className="text-hui-textMain font-medium">{formatCurrency(phase.totalActual)}</span></span>
                <span>Labor {formatCurrency(phase.actualLabor)} / {formatCurrency(phase.laborBudget)}</span>
                <span>Materials {formatCurrency(phase.actualMaterial)} / {formatCurrency(phase.materialBudget)}</span>
                {pct !== null && <span>{(pct * 100).toFixed(0)}% used</span>}
            </div>

            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden mb-3">
                <div className={`h-2 ${over ? "bg-red-500" : "bg-green-500"}`} style={{ width: `${barWidth}%` }} />
            </div>

            {phase.items.length > 0 && (
                <div className="space-y-1 pl-3 border-l-2 border-slate-100">
                    {phase.items.map((item) => (
                        <div key={item.itemId} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                            <span className="text-hui-textMuted min-w-0 truncate max-w-[55%]" title={item.name}>
                                {item.name}
                                {item.phaseHasUnassignedActuals && (
                                    // AGENCY rule: we never spread phase-level spend across items to
                                    // make this look complete. Say the number is a floor instead.
                                    <span
                                        className="ml-1 text-amber-600"
                                        title="This phase has costs that aren't linked to any line item, so this actual is a floor, not a measurement."
                                    >
                                        ⚠ at least
                                    </span>
                                )}
                            </span>
                            <span className="text-hui-textMuted">
                                {formatCurrency(item.actual)} / {formatCurrency(item.budget)}{" "}
                                <VarianceAmount value={item.variance} className="ml-1" />
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default async function VarianceReportPage() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || (user.role !== "MANAGER" && user.role !== "ADMIN")) {
        return <div className="p-8 text-red-500">Access Denied. Managers Only.</div>;
    }

    const reports = await loadProjectVariance();

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-8">
            <div className="flex flex-wrap justify-between items-center gap-3">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Job Cost Variance</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Estimated vs actual — labor, burden, materials and subs — by phase and line item.
                    </p>
                </div>
                <Link href="/manager/time-entries" className="hui-btn hui-btn-primary">
                    View Time Entries Audit
                </Link>
            </div>

            {reports.map((report) => {
                const v = report.variance;
                const over = v.variance < 0;
                return (
                    <div key={report.projectId} className="hui-card overflow-hidden">
                        <div className="p-6 border-b border-hui-border bg-slate-50 flex flex-wrap justify-between items-start gap-4">
                            <div>
                                <h2 className="text-xl font-bold text-hui-textMain">{report.projectName}</h2>
                                <p className="text-sm text-hui-textMuted mt-1">
                                    Budget {formatCurrency(v.totalBudget)} · Actual {formatCurrency(v.totalActual)}
                                    {v.percentUsed !== null && ` · ${(v.percentUsed * 100).toFixed(0)}% used`}
                                </p>
                            </div>
                            <div className="text-right">
                                <div className="text-sm text-hui-textMuted mb-1">
                                    {over ? "Over budget by" : "Remaining"}
                                </div>
                                <div className="text-xl">
                                    <VarianceAmount value={v.variance} />
                                </div>
                            </div>
                        </div>

                        <div className="p-6 space-y-5">
                            <TrustBar variance={v} />

                            {v.phases.length === 0 ? (
                                <div className="text-sm text-hui-textMuted italic">
                                    No phases with a budget or actuals yet.
                                </div>
                            ) : (
                                <>
                                    <h3 className="text-sm font-semibold uppercase tracking-wider text-hui-textMuted">
                                        Phases — worst variance first
                                    </h3>
                                    <div className="space-y-3">
                                        {v.phases.map((phase) => (
                                            <PhaseRow key={phase.costCodeId} phase={phase} />
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                );
            })}

            {reports.length === 0 && (
                <div className="text-center py-12 text-hui-textMuted hui-card border-dashed">
                    No In Progress projects found.
                </div>
            )}
        </div>
    );
}
