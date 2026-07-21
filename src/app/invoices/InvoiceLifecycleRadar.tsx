import Link from "next/link";
import { formatCurrency } from "@/lib/utils";

const BUCKETS = [
    "Not sent",
    "Send interrupted",
    "Awaiting delivery",
    "Delivery unknown",
    "Sent not delivered",
    "Delivered not viewed",
    "Viewed not paid",
] as const;

export default function InvoiceLifecycleRadar({ receivables }: { receivables: any }) {
    const milestones = receivables.invoices.flatMap((invoice: any) =>
        invoice.unpaidMilestones.map((milestone: any) => ({ ...milestone, invoice })),
    );

    return (
        <section className="hui-card overflow-hidden">
            <div className="px-6 py-5 border-b border-hui-border flex items-end justify-between gap-4">
                <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-hui-primary">Lifecycle radar</p>
                    <h2 className="text-lg font-bold text-hui-textMain mt-1">Where every open payment request stands</h2>
                </div>
                <p className="text-sm text-hui-textMuted">{milestones.length} open milestone{milestones.length === 1 ? "" : "s"}</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-7 divide-y sm:divide-y-0 sm:divide-x divide-hui-border bg-slate-50/70">
                {BUCKETS.map((bucket, index) => {
                    const rows = milestones.filter((row: any) => row.lifecycleBucket === bucket);
                    return (
                        <div key={bucket} className="min-w-0 px-4 py-4">
                            <div className="flex items-center gap-2 mb-3">
                                <span className="w-5 h-5 rounded-full bg-white border border-hui-border text-[10px] font-bold text-hui-textMuted flex items-center justify-center">{index + 1}</span>
                                <h3 className="text-xs font-bold text-hui-textMain leading-tight">{bucket}</h3>
                                <span className="ml-auto text-[10px] font-bold text-hui-textMuted">{rows.length}</span>
                            </div>
                            <div className="space-y-2">
                                {rows.slice(0, 4).map((row: any) => (
                                    <Link
                                        key={row.id}
                                        href={`/projects/${row.invoice.projectId}/invoices/${row.invoice.invoiceId}`}
                                        className="block rounded-lg border border-hui-border bg-white p-2.5 hover:border-hui-primary/50 transition"
                                    >
                                        <p className="text-xs font-semibold text-hui-textMain truncate">{row.invoice.code} · {row.name}</p>
                                        <p className="text-[11px] text-hui-textMuted mt-1 truncate">{row.invoice.client || row.invoice.project || "Client"}</p>
                                        <div className="flex justify-between gap-2 mt-2 text-[11px]">
                                            <span className="font-semibold text-hui-textMain">{formatCurrency(row.amount)}</span>
                                            <span className="text-hui-textMuted">{row.daysSinceSent == null ? "—" : `${row.daysSinceSent}d`}</span>
                                        </div>
                                    </Link>
                                ))}
                                {rows.length === 0 && <p className="text-[11px] text-hui-textMuted py-2">Clear</p>}
                                {rows.length > 4 && <p className="text-[11px] text-hui-textMuted">+{rows.length - 4} more</p>}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="px-6 py-5 border-t border-hui-border">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold text-hui-textMain">Recently paid · 30 days</h3>
                    <span className="text-xs text-hui-textMuted">{receivables.recentlyPaid.length} payment{receivables.recentlyPaid.length === 1 ? "" : "s"}</span>
                </div>
                {receivables.recentlyPaid.length === 0 ? (
                    <p className="text-sm text-hui-textMuted">No payments recorded in the last 30 days.</p>
                ) : (
                    <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-2">
                        {receivables.recentlyPaid.slice(0, 9).map((row: any) => (
                            <Link key={row.id} href={`/projects/${row.projectId}/invoices/${row.invoiceId}`} className="rounded-lg border border-hui-border px-3 py-2.5 hover:bg-slate-50 transition">
                                <div className="flex justify-between gap-3">
                                    <p className="text-xs font-semibold text-hui-textMain truncate">{row.code} · {row.milestone}</p>
                                    <p className="text-xs font-bold text-hui-primary">{formatCurrency(row.amount)}</p>
                                </div>
                                <p className="text-[11px] text-hui-textMuted mt-1 truncate">
                                    {row.paymentMethod || "payment"}{row.referenceNumber ? ` · ${row.referenceNumber}` : ""} · {new Date(row.paidAt).toLocaleDateString()}
                                </p>
                            </Link>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
