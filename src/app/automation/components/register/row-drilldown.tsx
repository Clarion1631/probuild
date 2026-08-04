import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";
import { decimalToCents, type MergedRegisterRow } from "@/lib/register-merge";
import type { RawExpense } from "../../register-data";
import { amountSign, friendlyType } from "../format";
import CopyIdButton from "../copy-id-button";
import { StateChip } from "../shared/state-chip";
import { StepTimeline } from "../shared/step-timeline";
import { isStaleBookedApi } from "../shared/stale-detection";
import type { ReceiptJourneyMatch } from "./match-receipt-journey";
import { toSerializedJourney } from "./serialize-journey";

/**
 * The register row drill-down — read-only half only (Unified Money Register
 * plan §3/§5 step 9). Four blocks, rendered only when they apply to this
 * row: QuickBooks · ProBuild job cost · Receipt provenance timeline ·
 * Actions (seam only, no write actions — those need the step 8 APIs).
 *
 * Pure presentational: all data (the row, its richer Expense projection, and
 * its matched receipt journey) is fetched and matched by the caller
 * (`page.tsx`, via `register-data.ts` and `match-receipt-journey.ts`) so this
 * stays a plain server component with no I/O of its own.
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
                    <span className="text-xs text-hui-textMuted italic">No QuickBooks transaction id on this row.</span>
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
                <p className="text-sm text-hui-textMuted">No matching ProBuild job-cost expense found.</p>
            </DrilldownSection>
        );
    }

    const projectId = expense.estimate?.project?.id ?? row.projectId;
    const projectName = expense.estimate?.project?.name ?? row.projectName;
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
                            Amount could not be parsed as an exact cent value — no delta shown.
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
            <DrilldownSection title="Receipt provenance">
                <p className="text-sm text-hui-textMuted">
                    No audit record for this receipt — that&apos;s not evidence it&apos;s missing, only that no
                    receipt-push event has been matched to it.
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
        <DrilldownSection title="Receipt provenance">
            {journeyMatch.unconfirmed && (
                <div className="mb-3 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Possible prefix collision — unconfirmed. Two different Drive files can share this identifier, so
                    this may not be the receipt behind this row.
                </div>
            )}
            <div className="flex items-center gap-2 mb-3">
                <StateChip state={journey.finalState} />
                {journey.backfilled && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">
                        Imported history
                    </span>
                )}
            </div>
            <StepTimeline steps={journey.steps} showPendingSync={showPendingSync} />
            {stale && (
                <p className="text-xs font-medium text-red-700 mt-2">
                    Booked but not yet in ProBuild — worth a look.
                </p>
            )}
            {openReceiptHref && (
                <a
                    href={openReceiptHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-3 text-xs font-medium text-hui-primary hover:underline"
                >
                    Open receipt ↗
                </a>
            )}
        </DrilldownSection>
    );
}

function ActionsBlock() {
    return (
        <DrilldownSection title="Actions">
            {/*
             * Unified Money Register plan §5 step 8 wires the review-alert
             * schema/outbox and its own financialReports/admin-gated APIs.
             * Step 9 (this file) is read-only — "Ask Marge to review" and
             * "Mark reviewed" get wired in HERE once those APIs exist. Do
             * not add a write path in this block ahead of step 8.
             */}
            <div className="flex items-center gap-2 flex-wrap">
                <button type="button" disabled title="Coming soon" className="hui-btn hui-btn-secondary text-xs px-2 py-0.5 disabled:opacity-50">
                    Ask Marge to review
                </button>
                <button type="button" disabled title="Coming soon" className="hui-btn hui-btn-secondary text-xs px-2 py-0.5 disabled:opacity-50">
                    Mark reviewed
                </button>
            </div>
        </DrilldownSection>
    );
}

export function RowDrilldown({
    row,
    expense,
    journeyMatch,
    now,
}: {
    row: MergedRegisterRow;
    expense: RawExpense | null;
    journeyMatch: ReceiptJourneyMatch | null;
    now: number;
}) {
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <QuickBooksBlock row={row} />
            <JobCostBlock row={row} expense={expense} />
            <ReceiptTimelineBlock row={row} journeyMatch={journeyMatch} receiptUrl={row.receiptUrl} now={now} />
            {row.edges && <ActionsBlock />}
        </div>
    );
}
