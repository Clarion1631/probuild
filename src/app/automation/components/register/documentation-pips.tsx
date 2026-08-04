import type { MergedRegisterRow } from "@/lib/register-merge";

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

/**
 * The three receipt/job-cost/amount pips for one register row (Unified Money
 * Register plan §3). `unknown` (grey) means "no audit record either way" —
 * NEVER a guess presented as a pass or a fail (plan §1). Rows whose status is
 * `not-applicable` or `unclassifiable` — or that simply have no edges
 * (out-of-scope row types, plan §1's scope note) — render their typed
 * `label` text instead, no pips.
 */
export function DocumentationPips({ row }: { row: MergedRegisterRow }) {
    if (row.status === "not-applicable" || row.status === "unclassifiable" || !row.edges) {
        return <span className="text-xs text-hui-textMuted">{row.label}</span>;
    }

    const { edges } = row;

    const receiptState: PipState = edges.receipt === "pass" ? "pass" : "unknown";
    const receiptTooltip = edges.receipt === "pass"
        ? "Receipt-push audit record found — matched to this QuickBooks purchase."
        : edges.receiptUnconfirmed
            ? "Possible match found via legacy prefix lookup — unconfirmed, could be a different receipt."
            : "No audit record either way — not a guess, not a fail.";

    const jobCostState: PipState = edges.jobCost === "pass" ? "pass" : "fail";
    const jobCostTooltip = edges.jobCost === "pass"
        ? "Matched to a ProBuild job-cost expense."
        : "No matching ProBuild job-cost expense found.";

    const amountState: PipState =
        edges.amount === "pass" ? "pass"
            : edges.amount === "fail" || edges.amount === "indeterminate" ? "fail"
                : "na";
    const amountTooltip =
        edges.amount === "pass" ? "ProBuild expense amount matches this QuickBooks entry exactly."
            : edges.amount === "fail" ? "ProBuild expense amount does not match this QuickBooks entry."
                : edges.amount === "indeterminate" ? "Expense amount couldn't be parsed as an exact cent value."
                    : "No job-cost match — amount can't be compared.";

    return (
        <div>
            <div className="flex items-center gap-1.5">
                <Pip state={receiptState} label="Receipt" tooltip={receiptTooltip} />
                <Pip state={jobCostState} label="Job cost" tooltip={jobCostTooltip} />
                <Pip state={amountState} label="Amount" tooltip={amountTooltip} />
            </div>
            {row.status === "job-cost-matched" && (
                <p className="text-xs text-sky-700 mt-1">{row.label}</p>
            )}
            {row.status === "needs-review" && (
                <p className="text-xs text-red-700 mt-1">{row.label}</p>
            )}
            {edges.receiptUnconfirmed && row.status !== "needs-review" && (
                <p className="text-xs text-amber-700 mt-1">
                    Receipt match unconfirmed — legacy prefix lookup, possible collision.
                </p>
            )}
        </div>
    );
}
