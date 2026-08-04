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

export function formatRelativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hr${diffHours === 1 ? "" : "s"} ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
