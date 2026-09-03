import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";
import { decimalToCents, type MergedRegisterRow } from "@/lib/register-merge";
import { resolveExpenseProjectLabel } from "@/lib/expense-attribution";
import type { OpenReviewIssue, RawExpense } from "../../register-data";
import { amountSign, friendlyType } from "../format";
import CopyIdButton from "../copy-id-button";
import { StateChip } from "../shared/state-chip";
import { StepTimeline } from "../shared/step-timeline";
import { isStaleBookedApi } from "../shared/stale-detection";
import { ReceiptThumb } from "../shared/receipt-thumb";
import MarkReviewedButton from "./mark-reviewed-button";
import type { ReceiptJourneyMatch } from "./match-receipt-journey";
import { toSerializedJourney } from "./serialize-journey";

/**
 * The register row drill-down (Unified Money Register plan §3/§5 step 9).
 * Four blocks, rendered only when they apply to this row: QuickBooks ·
 * ProBuild job cost · Receipt provenance timeline · Actions. "Mark reviewed"
 * in the Actions block now writes, via step 8's mark-reviewed API and the
 * `MarkReviewedButton` client-component extraction below — "Ask Marge to
 * review" is still a seam, no API for it exists yet.
 *
 * Otherwise pure presentational: all data (the row, its richer Expense
 * projection, its matched receipt journey, and its open review issue) is
 * fetched and matched by the caller (`page.tsx`, via `register-data.ts` and
 * `match-receipt-journey.ts`) so this stays a plain server component with no
 * I/O of its own.
 */

function DrilldownSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="hui-card p-4">
            <h4 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-3">{title}</h4>
            {children}
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div>
            <p className="text-xs text-hui-textMuted">{label}</p>
            <div className="text-sm text-hui-textMain">{children}</div>
        </div>
    );
}

function QuickBooksBlock({ row }: { row: MergedRegisterRow }) {
    return (
        <DrilldownSection title="QuickBooks">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Type">
                    <span title={row.qbType}>{friendlyType(row.qbType, row.docNum)}</span>
                </Field>
                <Field label="Doc/Check #">{row.docNum ?? "—"}</Field>
                <Field label="Payee">{row.name ?? "—"}</Field>
                <Field label="Amount">
                    <span className={`font-medium tabular-nums ${row.amountCents > 0 ? "text-teal-700" : "text-hui-textMain"}`}>
                        {amountSign(row.amountCents)}
                        {formatCurrency(Math.abs(row.amountCents) / 100)}
                    </span>
                </Field>
            </div>
            <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-hui-border">
                {row.isPurchaseType && row.qbTxnId && (
                    <a
                        href={`https://qbo.intuit.com/app/expense?txnId=${encodeURIComponent(row.qbTxnId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Best-effort link — if it doesn't open the purchase, use the copied ID to search in QuickBooks"
                        className="hui-btn hui-btn-secondary text-xs px-2 py-0.5"
                    >
                        Open in QuickBooks ↗
                    </a>
                )}
                {row.qbTxnId ? (
                    <CopyIdButton value={row.qbTxnId} label="QuickBooks ID" />
                ) : (
                    <span className="text-xs text-hui-textMuted italic">There&apos;s no QuickBooks transaction ID on this row.</span>
                )}
            </div>
        </DrilldownSection>
    );
}

function JobCostBlock({ row, expense }: { row: MergedRegisterRow; expense: RawExpense | null }) {
    if (!row.edges) return null;

    if (row.edges.jobCost !== "pass" || !expense) {
        return (
            <DrilldownSection title="ProBuild job cost">
                <p className="text-sm text-hui-textMuted">We couldn&apos;t find a matching expense in ProBuild for this purchase.</p>
            </DrilldownSection>
        );
    }

    // THE SHARED RESOLVER, in the right ORDER. This read the estimate FIRST
    // and never looked at `Expense.projectId` at all, so a re-attributed
    // expense showed — and linked to — the job it used to be on, in the panel a
    // bookkeeper opens precisely to check where a charge landed. The register
    // row stays as the last-resort fallback for an expense with no attribution
    // of its own.
    const resolved = resolveExpenseProjectLabel(expense);
    const projectId = resolved.projectId ?? row.projectId;
    const projectName = resolved.projectName ?? row.projectName;
    const expenseCents = decimalToCents(expense.amount);

    return (
        <DrilldownSection title="ProBuild job cost">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Project">
                    {projectId && projectName ? (
                        <a href={`/projects/${projectId}`} className="font-medium text-hui-primary hover:underline">
                            {projectName} ↗
                        </a>
                    ) : (
                        "—"
                    )}
                </Field>
                <Field label="Estimate">
                    {expense.estimate ? (
                        projectId ? (
                            <a
                                href={`/projects/${projectId}/estimates/${expense.estimate.id}`}
                                className="font-medium text-hui-primary hover:underline"
                            >
                                {expense.estimate.code || expense.estimate.title} ↗
                            </a>
                        ) : (
                            expense.estimate.code || expense.estimate.title
                        )
                    ) : (
                        "—"
                    )}
                </Field>
                <Field label="Expense amount">
                    {expenseCents !== null ? formatCurrency(expenseCents / 100) : `${expense.amount.toString()} (raw value)`}
                </Field>
                <Field label="Match">
                    {row.edges.amount === "pass" && <span className="text-teal-700">Matches QuickBooks exactly</span>}
                    {row.edges.amount === "indeterminate" && (
                        <span className="text-amber-700">
                            We couldn&apos;t read this amount as an exact dollar figure, so there&apos;s no difference shown.
                        </span>
                    )}
                    {row.edges.amount === "fail" && expenseCents !== null && (
                        <span className="text-red-700">
                            {formatCurrency(Math.abs(expenseCents + row.amountCents) / 100)}{" "}
                            {expenseCents + row.amountCents > 0 ? "more" : "less"} than QuickBooks
                        </span>
                    )}
                </Field>
            </div>
        </DrilldownSection>
    );
}

function ReceiptTimelineBlock({
    row,
    journeyMatch,
    receiptUrl,
    now,
}: {
    row: MergedRegisterRow;
    journeyMatch: ReceiptJourneyMatch | null;
    receiptUrl: string | null;
    now: number;
}) {
    if (!row.edges) return null;

    if (!journeyMatch) {
        return (
            <DrilldownSection title="Receipt tracking">
                <p className="text-sm text-hui-textMuted">
                    We don&apos;t have a record of this receipt in the automation yet. That doesn&apos;t mean it&apos;s
                    missing — we just haven&apos;t matched one to this purchase.
                </p>
            </DrilldownSection>
        );
    }

    const journey = toSerializedJourney(journeyMatch.journey);
    const showPendingSync = journey.finalState === "booked-api" && journey.syncedExpenseId === null;
    const stale = isStaleBookedApi(journey, now);
    const openReceiptHref =
        receiptUrl ?? journey.synced?.receiptUrl ?? (journey.driveFileId ? `https://drive.google.com/file/d/${journey.driveFileId}/view` : null);

    return (
        <DrilldownSection title="Receipt tracking">
            {journeyMatch.unconfirmed && (
                <div className="mb-3 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    We&apos;re not certain this is the right receipt. Two different files can share this same ID, so
                    this might be a different receipt than the one shown here.
                </div>
            )}
            <div className="flex items-center gap-2 mb-3">
                <StateChip state={journey.finalState} unconfirmed={journeyMatch.unconfirmed} />
                {journey.backfilled && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">
                        Imported history
                    </span>
                )}
            </div>
            <StepTimeline steps={journey.steps} showPendingSync={showPendingSync} unconfirmed={journeyMatch.unconfirmed} now={now} />
            {stale && (
                <p className="text-xs font-medium text-red-700 mt-2">
                    Booked but not yet in ProBuild — worth a look.
                </p>
            )}
            {openReceiptHref && (
                <div className="mt-3">
                    <ReceiptThumb url={openReceiptHref} fileName={journey.fileName ?? journey.docNumber} />
                </div>
            )}
        </DrilldownSection>
    );
}

function ActionsBlock({ reviewIssue }: { reviewIssue: OpenReviewIssue | null }) {
    return (
        <DrilldownSection title="Actions">
            {/*
             * Unified Money Register plan §5 step 8 wired the review-alert
             * schema/outbox and its own financialReports/admin-gated
             * mark-reviewed API
             * (src/app/api/automation/review-issues/mark-reviewed). "Mark
             * reviewed" is wired to it below via MarkReviewedButton, a small
             * client-component extraction so this file stays a plain server
             * component. "Ask Marge to review" still has no API to call —
             * stays disabled until that ships.
             */}
            <div className="flex items-center gap-2 flex-wrap">
                <button type="button" disabled title="Coming soon" className="hui-btn hui-btn-secondary text-xs px-2 py-0.5 disabled:opacity-50">
                    Ask Marge to review
                </button>
                {/* Keyed by the issue's full identity so a router.refresh()
                  * that changes the issue (new generation, externally
                  * acknowledged) remounts the button instead of leaving stale
                  * client state claiming the wrong review status. */}
                <MarkReviewedButton
                    key={reviewIssue ? `${reviewIssue.id}:${reviewIssue.version}:${reviewIssue.reasonHash}:${reviewIssue.acknowledged}` : "no-issue"}
                    issue={reviewIssue}
                />
            </div>
        </DrilldownSection>
    );
}

export function RowDrilldown({
    row,
    expense,
    journeyMatch,
    reviewIssue,
    now,
}: {
    row: MergedRegisterRow;
    expense: RawExpense | null;
    journeyMatch: ReceiptJourneyMatch | null;
    reviewIssue: OpenReviewIssue | null;
    now: number;
}) {
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <QuickBooksBlock row={row} />
            <JobCostBlock row={row} expense={expense} />
            <ReceiptTimelineBlock row={row} journeyMatch={journeyMatch} receiptUrl={row.receiptUrl} now={now} />
            {row.edges && <ActionsBlock reviewIssue={reviewIssue} />}
        </div>
    );
}
