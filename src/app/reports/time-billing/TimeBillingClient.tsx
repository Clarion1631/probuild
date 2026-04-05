"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";

interface TimeEntry {
    id: string;
    startTime: Date;
    endTime: Date | null;
    durationHours: number | null;
    laborCost: number | null;
    user: { id: string; name: string | null };
    project: { id: string; name: string };
    costCode: { code: string; name: string } | null;
}

interface Props {
    entries: TimeEntry[];
    groupBy: string;
}

export default function TimeBillingClient({ entries, groupBy }: Props) {
    const router = useRouter();
    const pathname = usePathname();

    const totalHours = entries.reduce((s, e) => s + (e.durationHours ?? 0), 0);
    const totalCost = entries.reduce((s, e) => s + (e.laborCost ?? 0), 0);

    const fmt = (n: number | any) => Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
    const fmtH = (n: number) => `${n.toFixed(1)}h`;

    // Group entries
    const groups: Record<string, TimeEntry[]> = {};
    for (const e of entries) {
        const key = groupBy === "project" ? e.project.name : (e.user.name ?? "Unknown");
        if (!groups[key]) groups[key] = [];
        groups[key].push(e);
    }
    const groupKeys = Object.keys(groups).sort();

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Time & Billing</h1>
                    <p className="text-sm text-hui-textMuted mt-1">All time entries with labor cost summary.</p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => router.push(`${pathname}?groupBy=employee`)}
                        className={`hui-btn text-sm ${groupBy === "employee" ? "hui-btn-primary" : "hui-btn-secondary"}`}
                    >
                        By Employee
                    </button>
                    <button
                        onClick={() => router.push(`${pathname}?groupBy=project`)}
                        className={`hui-btn text-sm ${groupBy === "project" ? "hui-btn-primary" : "hui-btn-secondary"}`}
                    >
                        By Project
                    </button>
                </div>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Hours</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{fmtH(totalHours)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Labor Cost</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{fmt(totalCost)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Avg Rate</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{totalHours > 0 ? fmt(totalCost / totalHours) + "/hr" : "—"}</p>
                </div>
            </div>

            {/* Groups */}
            {entries.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No time entries recorded yet.</div>
            ) : (
                groupKeys.map(key => {
                    const groupEntries = groups[key];
                    const groupHours = groupEntries.reduce((s, e) => s + (e.durationHours ?? 0), 0);
                    const groupCost = groupEntries.reduce((s, e) => s + (e.laborCost ?? 0), 0);
                    return (
                        <div key={key} className="hui-card overflow-hidden">
                            <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                                <span className="text-sm font-semibold text-hui-textMain">{key}</span>
                                <span className="text-sm text-hui-textMuted">{fmtH(groupHours)} · {fmt(groupCost)}</span>
                            </div>
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                        <th className="px-4 py-2">Date</th>
                                        {groupBy === "employee" && <th className="px-4 py-2">Project</th>}
                                        {groupBy === "project" && <th className="px-4 py-2">Employee</th>}
                                        <th className="px-4 py-2">Cost Code</th>
                                        <th className="px-4 py-2 text-right">Hours</th>
                                        <th className="px-4 py-2 text-right">Labor Cost</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {groupEntries.map(e => (
                                        <tr key={e.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                            <td className="px-4 py-3 text-hui-textMuted">
                                                {new Date(e.startTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                            </td>
                                            {groupBy === "employee" && (
                                                <td className="px-4 py-3 text-hui-textMain">
                                                    <Link href={`/projects/${e.project.id}`} className="hover:underline">{e.project.name}</Link>
                                                </td>
                                            )}
                                            {groupBy === "project" && (
                                                <td className="px-4 py-3 text-hui-textMuted">{e.user.name ?? "—"}</td>
                                            )}
                                            <td className="px-4 py-3 text-hui-textMuted text-xs">{e.costCode ? `${e.costCode.code} · ${e.costCode.name}` : "—"}</td>
                                            <td className="px-4 py-3 text-right text-hui-textMain">{e.durationHours != null ? fmtH(e.durationHours) : "—"}</td>
                                            <td className="px-4 py-3 text-right font-semibold text-hui-textMain">{e.laborCost != null ? fmt(e.laborCost) : "—"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    );
                })
            )}
        </div>
    );
}
