import type { MergedRegisterRow } from "@/lib/register-merge";
import { friendlyRowLabel } from "../format";

type PipState = "pass" | "fail" | "unknown" | "na";

const PIP_STYLE: Record<PipState, string> = {
    pass: "bg-teal-500",
    fail: "bg-red-500",
    unknown: "bg-slate-300",
    na: "bg-slate-200",
};

function Pip({ state, label, tooltip }: { state: PipState; label: string; tooltip: string }) {
    return (
        <span
            className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${PIP_STYLE[state]}`}
            title={`${label}: ${tooltip}`}
            aria-label={`${label}: ${tooltip}`}
        />
    );
}

/** One-time explanation of what the three dots mean, meant to sit above the
 * register table rather than repeat per row (there's already a title/aria
 * tooltip on every dot, but a bookkeeper shouldn't have to hover 141 rows to
 * learn the color code). */
export function DocumentationLegend() {
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-hui-textMuted">
            <span className="font-medium text-hui-textMain">The 3 dots mean:</span>
            <span className="inline-flex items-center gap-1.5">
                <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${PIP_STYLE.pass}`} /> Confirmed
            </span>
            <span className="inline-flex items-center gap-1.5">
                <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${PIP_STYLE.fail}`} /> Doesn&apos;t match
            </span>
            <span className="inline-flex items-center gap-1.5">
                <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${PIP_STYLE.unknown}`} /> Not checked yet
            </span>
            <span>Left to right: receipt, job cost, amount.</span>
        </div>
    );
}

/**
 * The three receipt/job-cost/amount pips for one register row (Unified Money
 * Register plan §3). `unknown` (grey) means we don't have anything on record
 * either way — NEVER a guess presented as a pass or a fail (plan §1). Rows
 * whose status is `not-applicable` or `unclassifiable` — or that simply have
 * no edges (out-of-scope row types, plan §1's scope note) — render a plain
 * status line instead, no pips.
 *
 * `suppressUnclassifiedNote`: when the page-wide "most rows aren't
 * categorized yet" banner is showing (page.tsx), the same "Not categorized
 * yet" line repeated on every row is noise — the banner already said it
 * once. This hides just that one recurring line; every other row-specific
 * note still renders normally.
 */
export function DocumentationPips({ row, suppressUnclassifiedNote = false }: { row: MergedRegisterRow; suppressUnclassifiedNote?: boolean }) {
    if (row.status === "not-applicable" || row.status === "unclassifiable" || !row.edges) {
        return <span className="text-xs text-hui-textMuted">{friendlyRowLabel(row.label)}</span>;
    }

    const { edges } = row;
    const isUnclassifiedNote = row.status === "needs-review" && row.classification === "unknown";

    const receiptState: PipState = edges.receipt === "pass" ? "pass" : "unknown";
    const receiptTooltip = edges.receipt === "pass"
        ? "We found a receipt record that matches this QuickBooks purchase."
        : edges.receiptUnconfirmed
            ? "We think we found a matching receipt, but we're not fully sure — it could be a different one."
            : "We don't have a record of this receipt either way. That's not a guess and not a red flag — we just haven't matched one to it.";

    const jobCostState: PipState = edges.jobCost === "pass" ? "pass" : "fail";
    const jobCostTooltip = edges.jobCost === "pass"
        ? "Matches an expense entered in ProBuild."
        : "We didn't find a matching expense in ProBuild.";

    const amountState: PipState =
        edges.amount === "pass" ? "pass"
            : edges.amount === "fail" || edges.amount === "indeterminate" ? "fail"
                : "na";
    const amountTooltip =
        edges.amount === "pass" ? "The amount in ProBuild matches this QuickBooks entry exactly."
            : edges.amount === "fail" ? "The amount in ProBuild doesn't match this QuickBooks entry."
                : edges.amount === "indeterminate" ? "We couldn't read this amount as an exact dollar figure, so we can't compare it."
                    : "No matching expense, so there's nothing to compare the amount to.";

    return (
        <div>
            <div className="flex items-center gap-1.5">
                <Pip state={receiptState} label="Receipt" tooltip={receiptTooltip} />
                <Pip state={jobCostState} label="Job cost" tooltip={jobCostTooltip} />
                <Pip state={amountState} label="Amount" tooltip={amountTooltip} />
            </div>
            {row.status === "job-cost-matched" && (
                <p className="text-xs text-sky-700 mt-1">{friendlyRowLabel(row.label)}</p>
            )}
            {row.status === "needs-review" && !(isUnclassifiedNote && suppressUnclassifiedNote) && (
                <p className="text-xs text-red-700 mt-1">{friendlyRowLabel(row.label)}</p>
            )}
            {edges.receiptUnconfirmed && row.status !== "needs-review" && (
                <p className="text-xs text-amber-700 mt-1">
                    We&apos;re not certain this is the right receipt.
                </p>
            )}
        </div>
    );
}
