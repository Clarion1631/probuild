const PURCHASE_TYPE_LABELS = new Set(["Expense", "Check", "Cash Expense", "Cash Purchase", "Credit Card Expense"]);

/** Human-friendly label for a GL "Transaction Type" — shared by the register
 * table and the row drill-down's QuickBooks block so the two never say
 * different things about the same row. */
export function friendlyType(qbType: string, docNum: string | null): string {
    if (PURCHASE_TYPE_LABELS.has(qbType)) {
        return qbType === "Check" && docNum ? "Check" : "Purchase";
    }
    if (qbType === "Deposit") return "Deposit";
    if (qbType === "Payment") return "Customer payment";
    if (qbType === "Journal Entry") return "Journal entry";
    if (qbType === "Sales Tax Payment") return "Sales tax payment";
    if (qbType === "Transfer") return "Transfer";
    return qbType;
}

/** "+" for money in, "-" for money out, and nothing for exactly zero — a
 * zero-value row is unclassifiable/non-spend, not money that "left" the
 * account, so "-$0.00" would misrepresent it. B7: decide the sign from the
 * ROUNDED-to-the-cent value, same rounding `formatCurrency` applies to the
 * amount shown right next to it — otherwise a sub-cent value like -0.001
 * prints as "-$0.00" (a sign the displayed digits don't back up).
 *
 * Codex round 1 finding 10: round the MAGNITUDE (`Math.round(Math.abs(x))`),
 * then reapply the ORIGINAL sign — never `Math.round(x)` directly.
 * `Math.round` rounds a halfway value toward +Infinity, not away from zero,
 * so `Math.round(-0.5) === -0`, which is NOT `< 0` (negative zero compares
 * equal to positive zero) — a genuine negative half-cent would silently
 * fall through to the empty-sign branch instead of "-", asymmetrically vs.
 * the equivalent positive case (`Math.round(0.5) === 1`, correctly "+").
 * Rounding the magnitude first sidesteps both: -0 never appears, and the
 * sign is never toward-zero-biased for a credit. */
export function amountSign(amountCents: number): "+" | "-" | "" {
    if (amountCents === 0) return "";
    const roundedMagnitude = Math.round(Math.abs(amountCents));
    if (roundedMagnitude === 0) return "";
    return amountCents > 0 ? "+" : "-";
}

/**
 * Plain-English rewrites for the register merge's internal status labels
 * (`MergedRegisterRow.label`, computed in `@/lib/register-merge` — off
 * limits to edit directly, see the automation copy-pass instructions).
 * Keyed on the exact internal string, so this translates the wording a
 * bookkeeper reads without touching the internal label logic that produces
 * it. Anything not in the map (including the dynamic "missing pieces" case
 * below) falls back to the original label rather than rendering blank. */
const LABEL_REWRITES: Record<string, string> = {
    "Zero-amount entry — not spend, excluded from denominator.":
        "Zero-dollar entry. Not real spending, so it's not counted here.",
    "Zero-amount entry — not spend.":
        "Zero-dollar entry. Nothing to document.",
    "Money came back on a purchase-type entry (refund or reversal).":
        "Money came back on a purchase. Looks like a refund or a reversal — worth a look.",
    "Classification conflict — classified overhead but matches a job-costed expense.":
        "This was marked as overhead, but it also matches a job cost. Worth a look to see which one is right.",
    "Classification conflict — classified owner draw but matches a job-costed expense.":
        "This was marked as an owner draw, but it also matches a job cost. Worth a look to see which one is right.",
    "Overhead spend — expected non-job cost.":
        "Overhead. Not tied to a job, so no job cost is expected.",
    "Owner draw — expected non-job cost.":
        "Owner draw. Not tied to a job, so no job cost is expected.",
    "Unclassified purchase — never auto-documented, never hidden.":
        "Not categorized yet. We don't know if this is a job cost or overhead.",
    "Documented — receipt, job cost, and amount all confirmed.":
        "Fully documented. Receipt, job cost, and amount all match.",
    "Needs review — expense amount could not be parsed as an exact cent value.":
        "Needs a look. The amount in ProBuild isn't a clean dollar figure, so we can't compare it exactly.",
    "Job cost and amount confirmed — no receipt-push audit record (likely a paper receipt entered directly in QuickBooks).":
        "Receipt not traced. Job cost and amount match, but we can't find the receipt in the automation records.",
    "No QuickBooks transaction id on this row — cannot join or alert.":
        "We can't match this row to anything else in QuickBooks — there's no transaction ID on it.",
    "Sign/type conflict — a money-in type posted as an outflow.":
        "This usually means money coming in, but here it went out. Worth a look.",
    "Refund receipt — unrecognized outflow.":
        "A refund receipt posted as money going out — that's unusual. Worth a look.",
    "Unrecognized transaction type posted as an outflow.":
        "We don't recognize this transaction type, and it's money going out. Worth a look.",
};

const NEEDS_REVIEW_UNRESOLVED = /^Needs review — (.+) unresolved\.$/;

/** Translates one of register-merge's internal status labels into plain
 * English for display (see `LABEL_REWRITES` above). Also handles the one
 * dynamic case — "Needs review — receipt, job cost unresolved." style
 * strings — by lifting out the plain-word list rather than trying to
 * enumerate every combination. */
export function friendlyRowLabel(label: string): string {
    const dynamic = NEEDS_REVIEW_UNRESOLVED.exec(label);
    if (dynamic) return `Needs a look. Missing: ${dynamic[1]}.`;
    return LABEL_REWRITES[label] ?? label;
}

/**
 * B6: `nowMs` is REQUIRED, not read from `Date.now()` in here — same reason
 * `isStaleBookedApi` (shared/stale-detection.ts) takes it as a parameter
 * instead: this runs inside components that render on the server (initial
 * SSR pass) and again on the client (hydration), and calling `Date.now()` in
 * each pass reads two different clock values, which can flip the rendered
 * text between passes and produce a hydration mismatch. Callers thread a
 * single timestamp captured once, server-side (see `page.tsx`'s `nowMs`),
 * through both render paths. The day-or-more fallback is pinned to Pacific
 * time, same as every other date display on this page (`step-timeline.tsx`,
 * `page.tsx`'s "fetched at" title) — a bare `toLocaleDateString` without a
 * `timeZone` reads the server/browser's local zone instead, which can print
 * a different calendar day than the rest of the page for the same instant.
 */
export function formatRelativeTime(date: Date, nowMs: number): string {
    const diffMs = nowMs - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hr${diffHours === 1 ? "" : "s"} ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}
