import { formatCurrency } from "@/lib/utils";
import type { DepositReviewItem } from "@/lib/deposit-review";

function statusClass(status: string): string {
    if (status === "reconcile") return "bg-red-50 text-red-700 border-red-200";
    if (status === "unmatched") return "bg-amber-50 text-amber-700 border-amber-200";
    return "bg-slate-100 text-slate-700 border-slate-200";
}

export function DepositReviewPanel({ items, unavailable }: { items: DepositReviewItem[]; unavailable: boolean }) {
    return (
        <section className="hui-card overflow-hidden" aria-labelledby="deposit-review-heading">
            <div className="p-5 border-b border-hui-border flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 id="deposit-review-heading" className="text-base font-semibold text-hui-textMain">Incoming check review</h2>
                    <p className="text-sm text-hui-textMuted mt-1 max-w-3xl">
                        Deposits that could not be safely applied. This panel is read-only: resolve the linked Office task before any retry.
                    </p>
                </div>
                <a href="/tasks" className="text-sm font-medium text-hui-primary hover:underline">Open Office tasks ↗</a>
            </div>
            {unavailable ? (
                <p className="m-5 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Deposit review data is unavailable right now. No payment decision was made.
                </p>
            ) : items.length === 0 ? (
                <p className="p-5 text-sm text-hui-textMuted">No deposits need review.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-hui-border bg-slate-50">
                                <th className="px-5 py-3 text-left text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Status</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Payer / project</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Check</th>
                                <th className="px-5 py-3 text-right text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Amount</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Why it stopped</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Links</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {items.map((item) => (
                                <tr key={item.id} className="align-top hover:bg-slate-50">
                                    <td className="px-5 py-3">
                                        <span className={`inline-flex border rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(item.status)}`}>
                                            {item.status}
                                        </span>
                                    </td>
                                    <td className="px-5 py-3 text-hui-textMain">
                                        <div>{item.payerName ?? "Payer not read"}</div>
                                        <div className="text-xs text-hui-textMuted mt-1">{item.projectName ?? "Project not read"}</div>
                                    </td>
                                    <td className="px-5 py-3 text-hui-textMain whitespace-nowrap">
                                        <div>{item.checkNumber ? `#${item.checkNumber}` : "Number not read"}</div>
                                        <div className="text-xs text-hui-textMuted mt-1">{item.checkDate ?? "Date not read"}</div>
                                    </td>
                                    <td className="px-5 py-3 text-right font-medium tabular-nums text-hui-textMain">
                                        {item.amountCents === null ? "Not read" : formatCurrency(item.amountCents / 100)}
                                    </td>
                                    <td className="px-5 py-3 text-hui-textMuted max-w-sm">{item.reason ?? "No reason recorded"}</td>
                                    <td className="px-5 py-3">
                                        <div className="flex flex-wrap gap-3 text-xs font-medium">
                                            {item.fileUrl && <a href={item.fileUrl} target="_blank" rel="noopener noreferrer" className="text-hui-primary hover:underline">Check image ↗</a>}
                                            {item.officeTaskId && <a href="/tasks" className="text-hui-primary hover:underline">Review task ↗</a>}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
