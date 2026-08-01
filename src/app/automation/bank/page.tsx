import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { getFreshQBTokens, QBNotConnectedError } from "@/lib/quickbooks-payments";
import {
    fetchBankRegister,
    attachVerdicts,
    type BankRegisterRowWithVerdict,
} from "@/lib/qbo-bank-register";
import { formatRelativeTime } from "../components/format";
import CopyIdButton from "./components/copy-id-button";

export const dynamic = "force-dynamic";

function StatCard({
    label,
    value,
    sub,
    valueClassName = "text-hui-textMain",
}: {
    label: string;
    value: string;
    sub?: string;
    valueClassName?: string;
}) {
    return (
        <div className="hui-card p-5">
            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${valueClassName}`}>{value}</p>
            {sub && <p className="text-xs text-hui-textMuted mt-1">{sub}</p>}
        </div>
    );
}

function Chip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
    return (
        <a
            href={href}
            className={`inline-flex items-center px-3 py-1 text-xs font-medium rounded-full transition ${
                active ? "bg-hui-primary text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
            }`}
        >
            {children}
        </a>
    );
}

function friendlyType(row: BankRegisterRowWithVerdict): string {
    const PURCHASE = new Set(["Expense", "Check", "Cash Expense", "Cash Purchase", "Credit Card Expense"]);
    if (PURCHASE.has(row.qbType)) {
        return row.qbType === "Check" && row.docNum ? "Check" : "Purchase";
    }
    if (row.qbType === "Deposit") return "Deposit";
    if (row.qbType === "Payment") return "Customer payment";
    if (row.qbType === "Journal Entry") return "Journal entry";
    if (row.qbType === "Sales Tax Payment") return "Sales tax payment";
    if (row.qbType === "Transfer") return "Transfer";
    return row.qbType;
}

function StatusChip({ row }: { row: BankRegisterRowWithVerdict }) {
    const verdict = row.verdict;
    switch (verdict.kind) {
        case "linked":
            if (verdict.amountMatches) {
                return (
                    <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700">
                        ✓ {verdict.projectName ?? "Job costed"}
                    </span>
                );
            }
            return (
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
                    Amount differs — ProBuild has {formatCurrency(verdict.expenseAmountCents / 100)}
                </span>
            );
        case "review":
            return (
                <span
                    className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700"
                    title={verdict.note}
                >
                    Review
                </span>
            );
        case "money-in":
            return (
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">
                    Money in
                </span>
            );
        case "transfer":
            return (
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    Transfer
                </span>
            );
        case "journal":
            return (
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    Journal
                </span>
            );
        case "tax-payment":
            return (
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    Sales tax
                </span>
            );
        case "bill-payment":
            return (
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    Bill payment
                </span>
            );
        default:
            return (
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    {row.qbType}
                </span>
            );
    }
}

function ConnectionErrorCard({ title, message }: { title: string; message: string }) {
    return (
        <div className="hui-card p-8 text-center">
            <h2 className="text-base font-semibold text-hui-textMain">{title}</h2>
            <p className="text-sm text-hui-textMuted mt-1">{message}</p>
        </div>
    );
}

export default async function BankRegisterPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const user = await getCurrentUserWithPermissions();
    if (!user) redirect("/login");
    if (!hasPermission(user, "financialReports")) redirect("/projects");

    const sp = await props.searchParams;
    const range = sp.range === "60" || sp.range === "90" ? sp.range : "30";
    const view = sp.view === "review" || sp.view === "in" || sp.view === "out" ? sp.view : "all";

    const endDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const rangeDays = Number(range);
    const startDateObj = new Date(`${endDate}T00:00:00Z`);
    // Both endpoints are inclusive in the GL report — "30d" means 30 dates,
    // so subtract rangeDays - 1 (Codex r1 off-by-one).
    startDateObj.setUTCDate(startDateObj.getUTCDate() - (rangeDays - 1));
    const startDate = startDateObj.toISOString().slice(0, 10);

    function chipHref(overrides: { range?: string; view?: string }) {
        const params = new URLSearchParams();
        params.set("range", overrides.range ?? range);
        params.set("view", overrides.view ?? view);
        return `/automation/bank?${params.toString()}`;
    }

    let rows: BankRegisterRowWithVerdict[] | null = null;
    let fetchedAt = "";
    let stale = false;
    let accountId = "";
    let errorCard: ReactNode = null;

    try {
        // Tokens are fetched lazily INSIDE fetchBankRegister — only on a
        // cache miss — because getFreshQBTokens refreshes OAuth every call.
        const register = await fetchBankRegister(getFreshQBTokens, startDate, endDate);
        rows = await attachVerdicts(register.rows);
        fetchedAt = register.fetchedAt;
        stale = register.stale;
        accountId = register.accountId;
    } catch (error) {
        if (error instanceof QBNotConnectedError) {
            errorCard = <ConnectionErrorCard title="QuickBooks isn't connected" message="Connect QuickBooks to see the bank register." />;
        } else {
            errorCard = (
                <ConnectionErrorCard
                    title="Couldn't load the bank register"
                    message="Couldn't load the register from QuickBooks — try again in a minute."
                />
            );
        }
    }

    if (!rows) {
        return (
            <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
                <div>
                    <a href="/automation" className="text-xs font-medium text-hui-primary hover:underline">
                        ← Automation
                    </a>
                    <h1 className="text-xl font-bold text-hui-textMain mt-2">Bank register</h1>
                </div>
                {errorCard}
            </div>
        );
    }

    const moneyInCents = rows.filter((r) => r.amountCents > 0).reduce((sum, r) => sum + r.amountCents, 0);
    const moneyOutCents = rows.filter((r) => r.amountCents < 0).reduce((sum, r) => sum + Math.abs(r.amountCents), 0);
    const purchaseRows = rows.filter((r) => r.isPurchase);
    const linkedCount = rows.filter((r) => r.verdict.kind === "linked").length;
    const needsReviewCount = rows.filter(
        (r) => r.verdict.kind === "review" || (r.verdict.kind === "linked" && !r.verdict.amountMatches)
    ).length;

    const filteredRows = rows.filter((row) => {
        if (view === "review") {
            return row.verdict.kind === "review" || (row.verdict.kind === "linked" && !row.verdict.amountMatches);
        }
        if (view === "in") return row.amountCents > 0;
        if (view === "out") return row.amountCents < 0;
        return true;
    });

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            {/* Header */}
            <div>
                <a href="/automation" className="text-xs font-medium text-hui-primary hover:underline">
                    ← Automation
                </a>
                <h1 className="text-xl font-bold text-hui-textMain mt-2">Bank register</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Posted QuickBooks entries for the Washington Trust checking account (account {accountId}), fetched{" "}
                    {formatRelativeTime(new Date(fetchedAt))}. This view can&apos;t see bank transactions that are pending,
                    excluded, or missing from QuickBooks — it shows what QuickBooks has posted, and whether each purchase
                    landed in ProBuild job costing.
                </p>
                {stale && (
                    <div className="mt-2 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        QuickBooks didn&apos;t answer just now — showing the last successful fetch.
                    </div>
                )}
            </div>

            {/* Summary strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Money in" value={formatCurrency(moneyInCents / 100)} valueClassName="text-teal-700" />
                <StatCard label="Money out" value={formatCurrency(moneyOutCents / 100)} />
                <StatCard
                    label="In ProBuild job costs"
                    value={String(linkedCount)}
                    sub={`of ${purchaseRows.length} purchases`}
                />
                <StatCard
                    label="Needs review"
                    value={String(needsReviewCount)}
                    sub="purchases not landed or amounts off"
                />
            </div>

            {/* Filter row */}
            <div className="flex gap-2 flex-wrap">
                <Chip href={chipHref({ range: "30" })} active={range === "30"}>
                    30d
                </Chip>
                <Chip href={chipHref({ range: "60" })} active={range === "60"}>
                    60d
                </Chip>
                <Chip href={chipHref({ range: "90" })} active={range === "90"}>
                    90d
                </Chip>
                <Chip href={chipHref({ view: "all" })} active={view === "all"}>
                    All
                </Chip>
                <Chip href={chipHref({ view: "review" })} active={view === "review"}>
                    Needs review
                </Chip>
                <Chip href={chipHref({ view: "in" })} active={view === "in"}>
                    Money in
                </Chip>
                <Chip href={chipHref({ view: "out" })} active={view === "out"}>
                    Money out
                </Chip>
            </div>

            {/* Table */}
            <div className="hui-card overflow-hidden">
                {filteredRows.length === 0 ? (
                    <p className="text-sm text-hui-textMuted py-8 text-center">Nothing here for this range.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-hui-border bg-slate-50">
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Date</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Type</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Doc/Check #</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Payee/Name</th>
                                    <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Amount</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">ProBuild status</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Links</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {filteredRows.map((row, i) => (
                                    <tr key={`${row.qbTxnId ?? "row"}-${i}`} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-3 text-hui-textMain whitespace-nowrap">{row.date}</td>
                                        <td className="px-4 py-3 text-hui-textMain">
                                            <span title={row.qbType}>{friendlyType(row)}</span>
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted">{row.docNum ?? "—"}</td>
                                        <td className="px-4 py-3 text-hui-textMain">
                                            {row.name ?? "—"}
                                            {row.verdict.kind === "review" && (
                                                <p className="text-xs text-hui-textMuted truncate max-w-xs" title={row.verdict.note}>
                                                    {row.verdict.note}
                                                </p>
                                            )}
                                        </td>
                                        <td
                                            className={`px-4 py-3 text-right font-medium tabular-nums ${
                                                row.amountCents > 0 ? "text-teal-700" : "text-hui-textMain"
                                            }`}
                                        >
                                            {row.amountCents > 0 ? "+" : "-"}
                                            {formatCurrency(Math.abs(row.amountCents) / 100)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <StatusChip row={row} />
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex gap-2 items-center flex-wrap text-xs">
                                                {row.isPurchase && row.qbTxnId && (
                                                    <a
                                                        href={`https://qbo.intuit.com/app/expense?txnId=${encodeURIComponent(row.qbTxnId)}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        title="Best-effort link — if it doesn't open the purchase, use the copied ID to search in QuickBooks"
                                                        className="font-medium text-hui-primary hover:underline"
                                                    >
                                                        QuickBooks ↗
                                                    </a>
                                                )}
                                                {row.qbTxnId && <CopyIdButton value={row.qbTxnId} label="QuickBooks ID" />}
                                                {row.verdict.kind === "linked" && row.verdict.receiptUrl && (
                                                    <a
                                                        href={row.verdict.receiptUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="font-medium text-hui-primary hover:underline"
                                                    >
                                                        Receipt ↗
                                                    </a>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
            <p className="text-xs text-hui-textMuted mt-2">
                {filteredRows.length} entries · {startDate} to {endDate}
            </p>
        </div>
    );
}
