export interface StatCardProps {
    label: string;
    value: string;
    sub?: string;
    valueClassName?: string;
}

/** Shared tile used by both `/automation` and `/automation/bank` — was
 * defined twice inline (identical except `bank/page.tsx` also accepted a
 * `valueClassName` override for the "Money in" tile's teal value). This is
 * that superset: the default matches the plain version exactly. */
export function StatCard({ label, value, sub, valueClassName = "text-hui-textMain" }: StatCardProps) {
    return (
        <div className="hui-card p-5">
            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${valueClassName}`}>{value}</p>
            {sub && <p className="text-xs text-hui-textMuted mt-1">{sub}</p>}
        </div>
    );
}
