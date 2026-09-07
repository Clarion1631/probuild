
import { nonVoidedTimeEntryWhere } from "@/lib/time-entry-void";
import { prisma } from "@/lib/prisma";
import { expenseHasAnyProjectWhere, resolveExpenseProjectId } from "@/lib/expense-attribution";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { toNum } from "@/lib/prisma-helpers";
import { formatCurrency } from "@/lib/utils";
import OverheadEditor from "./OverheadEditor";
import { formatMoneyDate } from "@/lib/payment-date";

export const dynamic = "force-dynamic";

type PeriodKey = "month" | "quarter" | "ytd" | "all";

const PERIODS: { key: PeriodKey; label: string }[] = [
    { key: "month", label: "This Month" },
    { key: "quarter", label: "This Quarter" },
    { key: "ytd", label: "Year to Date" },
    { key: "all", label: "All Time" },
];

function periodRange(period: PeriodKey, now: Date): { from: Date | null; months: number } {
    const y = now.getFullYear();
    if (period === "month") return { from: new Date(y, now.getMonth(), 1), months: 1 };
    if (period === "quarter") {
        const qStart = Math.floor(now.getMonth() / 3) * 3;
        return { from: new Date(y, qStart, 1), months: now.getMonth() - qStart + 1 };
    }
    if (period === "ytd") return { from: new Date(y, 0, 1), months: now.getMonth() + 1 };
    return { from: null, months: 0 }; // all-time months computed from data
}

function inPeriod(d: Date | null | undefined, from: Date | null): boolean {
    if (!d) return false;
    if (!from) return true;
    return new Date(d) >= from;
}

export default async function ProfitabilityPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return redirect("/login");
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { role: true } });
    if (!user || !["ADMIN", "MANAGER", "FINANCE"].includes(user.role)) {
        return <div className="p-8 text-red-500">Access denied. Admin, Manager, or Finance only.</div>;
    }
    const canEditOverhead = ["ADMIN", "FINANCE"].includes(user.role);

    const sp = await searchParams;
    const period = (PERIODS.some(p => p.key === sp.period) ? sp.period : "ytd") as PeriodKey;
    const now = new Date();
    const { from } = periodRange(period, now);

    const [projects, expenses, settings] = await Promise.all([
        prisma.project.findMany({
            include: {
                client: { select: { name: true } },
                estimates: {
                    where: { status: { in: ["Approved", "Invoiced", "Partially Paid", "Paid"] } },
                    select: { totalAmount: true },
                },
                invoices: {
                    select: {
                        id: true, code: true,
                        payments: {
                            select: {
                                name: true, amount: true, status: true, paidAt: true,
                                paymentDate: true, paymentMethod: true, referenceNumber: true,
                            },
                        },
                    },
                },
                timeEntries: { where: nonVoidedTimeEntryWhere(), select: { durationHours: true, laborCost: true, burdenCost: true, startTime: true } },
            },
            orderBy: { createdAt: "desc" },
        }),
        prisma.expense.findMany({
            // "attributable to SOME job", both ways round (Phase 3).
            where: expenseHasAnyProjectWhere(),
            select: {
                amount: true, date: true, createdAt: true, vendor: true, description: true, status: true,
                projectId: true,
                estimate: { select: { projectId: true } },
            },
        }),
        prisma.companySettings.findUnique({ where: { id: "singleton" }, select: { monthlyOverhead: true } }),
    ]);

    const expensesByProject = new Map<string, typeof expenses>();
    for (const e of expenses) {
        const pid = resolveExpenseProjectId(e);
        if (!pid) continue;
        if (!expensesByProject.has(pid)) expensesByProject.set(pid, []);
        expensesByProject.get(pid)!.push(e);
    }

    interface Row {
        id: string; name: string; client: string; status: string;
        contract: number; collected: number; labor: number; laborHours: number;
        expenses: number; gross: number;
        payments: { name: string; invoiceCode: string; amount: number; date: Date | null; method: string | null; reference: string | null }[];
        expenseRows: { vendor: string; description: string; amount: number; date: Date | null; status: string }[];
    }

    let earliestPayment: Date | null = null;
    const rows: Row[] = projects.map(p => {
        const contract = p.estimates.reduce((s, e) => s + toNum(e.totalAmount), 0);

        const payments: Row["payments"] = [];
        for (const inv of p.invoices) {
            for (const pay of inv.payments) {
                if (pay.status !== "Paid") continue;
                const date = pay.paidAt || pay.paymentDate;
                if (date && (!earliestPayment || new Date(date) < earliestPayment)) earliestPayment = new Date(date);
                if (!inPeriod(date, from)) continue;
                payments.push({
                    name: pay.name, invoiceCode: inv.code, amount: toNum(pay.amount),
                    date: date ? new Date(date) : null,
                    method: pay.paymentMethod, reference: pay.referenceNumber,
                });
            }
        }
        const collected = payments.reduce((s, x) => s + x.amount, 0);

        const periodEntries = p.timeEntries.filter(te => inPeriod(te.startTime, from));
        const labor = periodEntries.reduce((s, te) => s + (toNum(te.laborCost) || 0) + (toNum(te.burdenCost) || 0), 0);
        const laborHours = periodEntries.reduce((s, te) => s + (te.durationHours || 0), 0);

        const projExpenses = (expensesByProject.get(p.id) || []).filter(e => inPeriod(e.date || e.createdAt, from));
        const expenseTotal = projExpenses.reduce((s, e) => s + toNum(e.amount), 0);

        return {
            id: p.id, name: p.name, client: p.client?.name || "—", status: p.status,
            contract, collected, labor, laborHours, expenses: expenseTotal,
            gross: collected - labor - expenseTotal,
            payments: payments.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0)),
            expenseRows: projExpenses.map(e => ({
                vendor: e.vendor || "—", description: e.description || "", amount: toNum(e.amount),
                date: e.date ? new Date(e.date) : new Date(e.createdAt), status: e.status,
            })),
        };
    }).filter(r => r.collected > 0 || r.labor > 0 || r.expenses > 0 || r.status === "In Progress" || r.status === "Substantial Completion");

    rows.sort((a, b) => b.collected - a.collected);

    const totals = rows.reduce(
        (acc, r) => ({
            collected: acc.collected + r.collected,
            labor: acc.labor + r.labor,
            expenses: acc.expenses + r.expenses,
            gross: acc.gross + r.gross,
            hours: acc.hours + r.laborHours,
            paymentCount: acc.paymentCount + r.payments.length,
            expenseCount: acc.expenseCount + r.expenseRows.length,
        }),
        { collected: 0, labor: 0, expenses: 0, gross: 0, hours: 0, paymentCount: 0, expenseCount: 0 }
    );

    const monthlyOverhead = toNum(settings?.monthlyOverhead || 0);
    let months = periodRange(period, now).months;
    if (period === "all") {
        const start = earliestPayment || now;
        months = Math.max(1, (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1);
    }
    const overheadTotal = monthlyOverhead * months;
    const net = totals.gross - overheadTotal;
    const dataGaps: string[] = [];
    if (totals.paymentCount === 0) dataGaps.push("no payments recorded yet (record them on invoices, or let the QuickBooks sync pull them in)");
    if (totals.hours === 0) dataGaps.push("no labor hours with cost (bring hours in from Gusto / mobile time-clock with crew rates set)");
    if (totals.expenseCount === 0) dataGaps.push("no expenses recorded (receipt intake from Google Drive)");
    if (monthlyOverhead === 0) dataGaps.push("monthly overhead is $0 (set it below so the answer includes rent, insurance, salaries)");

    const answerReady = dataGaps.length === 0;
    const margin = totals.collected > 0 ? (totals.gross / totals.collected) * 100 : 0;

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Profitability</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Collected revenue − labor − expenses − overhead. Company → project → transaction.</p>
                </div>
                <div className="flex gap-1 bg-white border border-hui-border rounded-lg p-1">
                    {PERIODS.map(p => (
                        <Link
                            key={p.key}
                            href={`/reports/profitability?period=${p.key}`}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${period === p.key ? "bg-slate-800 text-white" : "text-hui-textMuted hover:bg-slate-50"}`}
                        >
                            {p.label}
                        </Link>
                    ))}
                </div>
            </div>

            {/* THE answer */}
            <div className={`rounded-xl border p-6 ${!answerReady ? "bg-slate-50 border-slate-200" : net >= 0 ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <p className="text-sm font-medium text-hui-textMuted">Are we profitable, including overhead? ({PERIODS.find(p => p.key === period)?.label})</p>
                        <p className={`text-4xl font-bold mt-1 ${!answerReady ? "text-slate-500" : net >= 0 ? "text-green-700" : "text-red-700"}`}>
                            {!answerReady ? "Not enough data yet" : net >= 0 ? `YES — ${formatCurrency(net)} net` : `NO — ${formatCurrency(net)} net`}
                        </p>
                        <p className="text-sm text-hui-textMuted mt-1">
                            Gross profit {formatCurrency(totals.gross)} − overhead {formatCurrency(overheadTotal)} ({months} mo × {formatCurrency(monthlyOverhead)})
                        </p>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 text-sm">
                        <div><p className="text-hui-textMuted text-xs">Collected</p><p className="font-bold text-hui-textMain">{formatCurrency(totals.collected)}</p></div>
                        <div><p className="text-hui-textMuted text-xs">Labor (burdened)</p><p className="font-bold text-hui-textMain">{formatCurrency(totals.labor)}</p></div>
                        <div><p className="text-hui-textMuted text-xs">Expenses</p><p className="font-bold text-hui-textMain">{formatCurrency(totals.expenses)}</p></div>
                        <div><p className="text-hui-textMuted text-xs">Gross margin</p><p className="font-bold text-hui-textMain">{margin.toFixed(1)}%</p></div>
                    </div>
                </div>
                {dataGaps.length > 0 && (
                    <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <p className="text-xs font-semibold text-amber-800 mb-1">To make this number trustworthy, these pipes still need data:</p>
                        <ul className="text-xs text-amber-800 list-disc ml-4 space-y-0.5">
                            {dataGaps.map((g, i) => <li key={i}>{g}</li>)}
                        </ul>
                    </div>
                )}
            </div>

            {/* Overhead config */}
            <OverheadEditor monthlyOverhead={monthlyOverhead} canEdit={canEditOverhead} />

            {/* Per-project rows with transaction drill-down */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                            <th className="py-3 px-4 font-normal">Project</th>
                            <th className="py-3 px-4 font-normal">Status</th>
                            <th className="py-3 px-4 font-normal text-right">Contract</th>
                            <th className="py-3 px-4 font-normal text-right">Collected</th>
                            <th className="py-3 px-4 font-normal text-right">Labor</th>
                            <th className="py-3 px-4 font-normal text-right">Expenses</th>
                            <th className="py-3 px-4 font-normal text-right">Gross Profit</th>
                            <th className="py-3 px-4 font-normal text-right">Margin</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {rows.map(r => {
                            const rowMargin = r.collected > 0 ? (r.gross / r.collected) * 100 : null;
                            const txnCount = r.payments.length + r.expenseRows.length;
                            return (
                            <tr key={r.id} className="align-top hover:bg-slate-50/60 transition">
                                <td className="py-3 px-4" colSpan={1}>
                                    <details className="group">
                                        <summary className="cursor-pointer list-none flex items-center gap-2">
                                            <svg className="w-3.5 h-3.5 text-slate-400 transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                                            <span>
                                                <Link href={`/projects/${r.id}`} className="font-medium text-slate-800 hover:text-indigo-600">{r.name}</Link>
                                                <span className="block text-xs text-slate-400">{r.client}{txnCount > 0 ? ` · ${txnCount} transaction${txnCount > 1 ? "s" : ""}` : ""}</span>
                                            </span>
                                        </summary>
                                        <div className="mt-3 ml-5 space-y-2 text-xs">
                                            {r.payments.map((p, i) => (
                                                <div key={`p${i}`} className="flex justify-between gap-3 bg-green-50/60 border border-green-100 rounded-md px-3 py-1.5">
                                                    <span className="text-slate-600 truncate">
                                                        <span className="text-green-700 font-semibold">IN</span> · {p.date ? formatMoneyDate(p.date) : "—"} · {p.invoiceCode} · {p.name}
                                                        {p.method ? ` · ${p.method === "quickbooks" ? "QuickBooks" : p.method}` : ""}{p.reference ? ` #${p.reference}` : ""}
                                                    </span>
                                                    <span className="font-semibold text-green-700 shrink-0">+{formatCurrency(p.amount)}</span>
                                                </div>
                                            ))}
                                            {r.expenseRows.map((e, i) => (
                                                <div key={`e${i}`} className="flex justify-between gap-3 bg-rose-50/60 border border-rose-100 rounded-md px-3 py-1.5">
                                                    <span className="text-slate-600 truncate">
                                                        <span className="text-rose-700 font-semibold">OUT</span> · {e.date ? e.date.toLocaleDateString() : "—"} · {e.vendor}{e.description ? ` · ${e.description}` : ""}{e.status === "Pending" ? " · pending review" : ""}
                                                    </span>
                                                    <span className="font-semibold text-rose-700 shrink-0">−{formatCurrency(e.amount)}</span>
                                                </div>
                                            ))}
                                            {r.laborHours > 0 && (
                                                <div className="flex justify-between gap-3 bg-blue-50/60 border border-blue-100 rounded-md px-3 py-1.5">
                                                    <span className="text-slate-600"><span className="text-blue-700 font-semibold">LABOR</span> · {r.laborHours.toFixed(1)} hrs (burdened)</span>
                                                    <span className="font-semibold text-blue-700 shrink-0">−{formatCurrency(r.labor)}</span>
                                                </div>
                                            )}
                                            {txnCount === 0 && r.laborHours === 0 && (
                                                <p className="text-slate-400 italic">No transactions in this period.</p>
                                            )}
                                        </div>
                                    </details>
                                </td>
                                <td className="py-3 px-4 text-xs text-slate-500 whitespace-nowrap">{r.status}</td>
                                <td className="py-3 px-4 text-right text-slate-500">{r.contract > 0 ? formatCurrency(r.contract) : "—"}</td>
                                <td className="py-3 px-4 text-right font-medium text-slate-800">{formatCurrency(r.collected)}</td>
                                <td className="py-3 px-4 text-right text-slate-600">{r.labor > 0 ? formatCurrency(r.labor) : "—"}</td>
                                <td className="py-3 px-4 text-right text-slate-600">{r.expenses > 0 ? formatCurrency(r.expenses) : "—"}</td>
                                <td className={`py-3 px-4 text-right font-semibold ${r.gross >= 0 ? "text-green-700" : "text-red-600"}`}>{formatCurrency(r.gross)}</td>
                                <td className="py-3 px-4 text-right text-slate-600">{rowMargin === null ? "—" : `${rowMargin.toFixed(0)}%`}</td>
                            </tr>
                        );})}
                        {rows.length === 0 && (
                            <tr><td colSpan={8} className="py-12 text-center text-slate-400">No financial activity in this period.</td></tr>
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-800">
                            <td className="py-3 px-4">Company total</td>
                            <td className="py-3 px-4"></td>
                            <td className="py-3 px-4"></td>
                            <td className="py-3 px-4 text-right">{formatCurrency(totals.collected)}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(totals.labor)}</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(totals.expenses)}</td>
                            <td className={`py-3 px-4 text-right ${totals.gross >= 0 ? "text-green-700" : "text-red-600"}`}>{formatCurrency(totals.gross)}</td>
                            <td className="py-3 px-4 text-right">{margin.toFixed(0)}%</td>
                        </tr>
                        <tr className="bg-slate-50 text-slate-600">
                            <td className="py-2 px-4" colSpan={6}>Overhead ({months} mo × {formatCurrency(monthlyOverhead)})</td>
                            <td className="py-2 px-4 text-right">−{formatCurrency(overheadTotal)}</td>
                            <td></td>
                        </tr>
                        <tr className={`font-bold ${net >= 0 ? "text-green-700" : "text-red-700"} bg-slate-50 border-t border-slate-200`}>
                            <td className="py-3 px-4" colSpan={6}>Net profit including overhead</td>
                            <td className="py-3 px-4 text-right">{formatCurrency(net)}</td>
                            <td></td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
