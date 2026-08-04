import { formatCurrency } from "@/lib/utils";
import type { OrphanReceipt } from "@/lib/register-merge";

/**
 * The actionable "receipts that never landed in the register" list (plan
 * §1/§3) — `exception` orphans only, `unknown` (no audit evidence either
 * way) is never shown here. Collapsible, default open when non-empty, same
 * "needs attention" framing as the old per-receipt journey list it replaces.
 */
export function OrphanReceipts({
    orphans,
    projectNames,
}: {
    orphans: OrphanReceipt[];
    projectNames: Map<string, string>;
}) {
    const isEmpty = orphans.length === 0;

    return (
        <details className="hui-card group" open={!isEmpty}>
            <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between text-base font-semibold text-hui-textMain select-none">
                <span>Receipts that never reached the bank {!isEmpty && <span className="text-hui-textMuted font-normal">({orphans.length})</span>}</span>
                <span className="text-xs font-normal text-hui-textMuted group-open:hidden">Show</span>
                <span className="text-xs font-normal text-hui-textMuted hidden group-open:inline">Hide</span>
            </summary>
            <div className="border-t border-hui-border overflow-hidden">
                {isEmpty ? (
                    <p className="text-sm text-hui-textMuted px-5 py-6">No receipts stuck outside the bank register right now.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-hui-border bg-slate-50">
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">File</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Vendor</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project</th>
                                    <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Amount</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Why it&apos;s stuck</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {orphans.map((o) => (
                                    <tr key={o.key} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-3 text-hui-textMain max-w-xs truncate" title={o.fileName ?? undefined}>
                                            {o.fileName ?? "—"}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted">{o.vendor ?? "—"}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">{projectNames.get(o.key) ?? "—"}</td>
                                        <td className="px-4 py-3 text-right font-medium tabular-nums text-hui-textMain">
                                            {o.amountCents != null ? formatCurrency(o.amountCents / 100) : "—"}
                                        </td>
                                        <td className="px-4 py-3 text-red-700">
                                            {o.reason ?? o.finalStatus ?? "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </details>
    );
}
