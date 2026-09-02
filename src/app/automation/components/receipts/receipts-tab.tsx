import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";
import { resolveDocUrl } from "@/lib/secure-storage";
import { retryTargetFor } from "@/lib/receipt-intake/route-state";
import { isPossibleOrphanReason } from "@/lib/receipt-intake/park";
import { StatCard } from "../shared/stat-card";
import MarkReviewedButton from "../register/mark-reviewed-button";
import {
    RECEIPT_GROUPS,
    RECEIPT_GROUP_LABELS,
    OWNER_ORDER,
    groupIsVisible,
    type ReceiptFilters,
    type ReceiptGroup,
} from "../../receipts-filters";
import type { IntakeRow, MissingReceiptRow, ReceiptQueue } from "../../receipts-data";
import {
    AssignOwnerControl,
    MarkDuplicateControl,
    NotADuplicateButton,
    ResolveOrphanButton,
    RetryButton,
    SetJobControl,
    UncertainCardControls,
    UnknownOrphanControls,
    VoidButton,
} from "./receipt-row-actions";

/**
 * The Receipts queue (Phase 2 §2). A server component: the only client code
 * here is the row-action buttons, which are their own small island.
 *
 * Layout follows the register's own conventions rather than DESIGN_SYSTEM.md's
 * named-but-nonexistent TabButton/EmptyState exports — `FilterChip`-style
 * anchors, `StatCard` tiles, `hui-card` panels.
 */

function EmptyGroup({ message }: { message: string }) {
    return <p className="text-sm text-hui-textMuted py-8 text-center">{message}</p>;
}

function GroupCard({ title, count, children }: { title: string; count: number; children: ReactNode }) {
    return (
        <section className="hui-card overflow-hidden">
            <header className="flex items-center gap-2 px-4 py-3 border-b border-hui-border bg-slate-50">
                <h2 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{title}</h2>
                <span className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 text-xs font-semibold rounded-full bg-white border border-slate-300 text-slate-700">
                    {count}
                </span>
            </header>
            {children}
        </section>
    );
}

function amountLabel(cents: number | null): string {
    if (cents === null) return "—";
    return formatCurrency(Math.abs(cents) / 100);
}

function RowShell({ children }: { children: ReactNode }) {
    return <div className="group px-4 py-3 border-b border-slate-100 last:border-b-0 flex flex-wrap gap-x-4 gap-y-2 items-center justify-between">{children}</div>;
}

function RowFacts({ row }: { row: IntakeRow }) {
    return (
        <div className="min-w-[16rem]">
            <p className="text-sm text-hui-textMain font-medium">
                {row.vendor ?? row.fileName ?? "Unread receipt"}
                <span className="ml-2 font-normal tabular-nums">{amountLabel(row.totalCents)}</span>
            </p>
            <p className="text-xs text-hui-textMuted">
                {row.txnDate ?? row.createdAt.slice(0, 10)} · {row.source}
                {row.projectName ? ` · ${row.projectName}` : ""}
            </p>
        </div>
    );
}

/**
 * "Open receipt" is a short-lived signed URL minted at render time from the
 * private bucket — there is no public receipt URL to link to, and there must
 * not be one. A null result renders as nothing rather than a dead link.
 */
async function ReceiptLink({ storagePath }: { storagePath: string }) {
    const url = await resolveDocUrl(storagePath);
    if (!url) return null;
    return (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-hui-primary hover:underline">
            Open receipt ↗
        </a>
    );
}

function QuickBooksLink({ qbPurchaseId }: { qbPurchaseId: string }) {
    return (
        <a
            href={`https://qbo.intuit.com/app/expense?txnId=${encodeURIComponent(qbPurchaseId)}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Best-effort link — if it doesn't open the purchase, search the id in QuickBooks"
            className="text-xs font-medium text-hui-primary hover:underline"
        >
            QuickBooks ↗
        </a>
    );
}

export function ReceiptsTab({
    queue,
    filters,
    jobs,
    filterHref,
}: {
    queue: ReceiptQueue;
    filters: ReceiptFilters;
    jobs: Array<{ id: string; name: string }>;
    filterHref: (overrides: { group?: string; owner?: string }) => string;
}) {
    const counts: Record<ReceiptGroup, number> = {
        "needs-job": queue.counts.needsJob,
        "needs-review": queue.counts.needsReview,
        booking: queue.counts.booking,
        "booked-today": queue.counts.bookedToday,
        "missing-receipts": queue.counts.missingReceipts,
        duplicates: queue.counts.duplicates,
        exceptions: queue.counts.exceptions,
        "uncertain-cards": queue.counts.uncertainCards,
    };

    const missingByOwner = OWNER_ORDER
        .map(owner => ({ owner, rows: queue.missingReceipts.filter(row => row.owner === owner) }))
        .filter(bucket => bucket.rows.length > 0);
    const unknownOwnerRows = queue.missingReceipts.filter(row => !OWNER_ORDER.includes(row.owner as never));
    if (unknownOwnerRows.length > 0) missingByOwner.push({ owner: "unassigned", rows: unknownOwnerRows });

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                <StatCard label="Waiting on a person" value={String(counts["needs-job"] + counts["needs-review"])} sub="Needs a job or a decision" />
                <StatCard label="In flight" value={String(counts.booking)} sub="Booking into QuickBooks" />
                <StatCard label="Missing receipts" value={String(counts["missing-receipts"])} sub="Bank charges with no receipt found" />
            </div>

            {/* Group filter chips, each carrying its own count badge. */}
            <div className="flex gap-2 flex-wrap items-center">
                <a
                    href={filterHref({ group: "" })}
                    className={`inline-flex items-center px-3 py-1 text-xs font-medium rounded-full transition ${
                        filters.group === null ? "bg-hui-primary text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
                    }`}
                >
                    All
                </a>
                {RECEIPT_GROUPS.map(group => (
                    <a
                        key={group}
                        href={filterHref({ group })}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full transition ${
                            filters.group === group ? "bg-hui-primary text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
                        }`}
                    >
                        {RECEIPT_GROUP_LABELS[group]}
                        <span className={`tabular-nums ${filters.group === group ? "text-white/80" : "text-slate-500"}`}>{counts[group]}</span>
                    </a>
                ))}
            </div>

            {groupIsVisible("uncertain-cards", filters) && queue.counts.uncertainCards > 0 && (
                <GroupCard title={RECEIPT_GROUP_LABELS["uncertain-cards"]} count={counts["uncertain-cards"]}>
                    <p className="px-4 py-2 text-xs text-amber-800 bg-amber-50 border-b border-amber-100">
                        We asked Google Chat to post these cards and never got a confirmed answer. They are not resent
                        automatically — a duplicate chase card is worse than a late one. Open the Receipts Need Review
                        space, look for the card, and say which way it went.
                    </p>
                    {queue.uncertainCards.map(card => (
                        <RowShell key={card.id}>
                            <div className="min-w-[16rem]">
                                <p className="text-sm font-medium text-hui-text">
                                    {card.owner} · {card.pacificDate}
                                </p>
                                <p className="text-xs text-hui-textMuted mt-1">
                                    {card.items} item{card.items === 1 ? "" : "s"} · {card.attempts} attempt
                                    {card.attempts === 1 ? "" : "s"}
                                    {card.lastError ? ` · ${card.lastError}` : ""}
                                </p>
                            </div>
                            <UncertainCardControls cardId={card.id} expectedUpdatedAt={card.updatedAt} />
                        </RowShell>
                    ))}
                </GroupCard>
            )}

            {groupIsVisible("exceptions", filters) && queue.counts.exceptions > 0 && (
                <GroupCard title={RECEIPT_GROUP_LABELS.exceptions} count={counts.exceptions}>
                    <p className="px-4 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100">
                        Each of these was voided or re-classified after the send to QuickBooks had already started.
                        Where the purchase id is known it is linked below — open it in QuickBooks, void it there, then
                        mark it resolved. Nothing here can remove it for you.
                    </p>
                    {queue.exceptions.map(row => (
                        <RowShell key={row.id}>
                            <div className="min-w-[16rem]">
                                <RowFacts row={row} />
                                <p className="text-xs text-hui-textMuted mt-1">
                                    state <span className="font-mono">{row.state}</span>
                                    {row.stateReason ? ` · ${row.stateReason}` : ""}
                                </p>
                                {isPossibleOrphanReason(row.stateReason) && !row.postVoidQbPurchaseId && (
                                    <p className="text-xs text-red-700 mt-1">
                                        The send had started, so QuickBooks may hold a purchase we never got an answer
                                        for. Check QuickBooks for this vendor and amount. This receipt stays blocked
                                        from re-sending until you resolve it, so the same purchase can&apos;t book twice.
                                    </p>
                                )}
                            </div>
                            <div className="flex flex-col items-end gap-3">
                                <div className="flex items-center gap-3 flex-wrap">
                                    {row.postVoidQbPurchaseId && (
                                        <>
                                            <QuickBooksLink qbPurchaseId={row.postVoidQbPurchaseId} />
                                            <ResolveOrphanButton intakeId={row.id} qbPurchaseId={row.postVoidQbPurchaseId} expectedUpdatedAt={row.updatedAt} />
                                        </>
                                    )}
                                </div>
                                {/* UNKNOWN-id rows only. A row that already has a purchase id is
                                    resolved by "mark resolved" above, and the unknown-id action's
                                    predicate excludes it (`postVoidQbPurchaseId: null`) — so
                                    offering the control here would be offering a button that can
                                    only ever refuse. */}
                                {!row.postVoidQbPurchaseId && (
                                    <UnknownOrphanControls intakeId={row.id} expectedUpdatedAt={row.updatedAt} />
                                )}
                            </div>
                        </RowShell>
                    ))}
                </GroupCard>
            )}

            {groupIsVisible("needs-job", filters) && (
                <GroupCard title={RECEIPT_GROUP_LABELS["needs-job"]} count={counts["needs-job"]}>
                    {queue.needsJob.length === 0 ? (
                        <EmptyGroup message="Nothing here — every receipt has a job." />
                    ) : (
                        queue.needsJob.map(row => (
                            <RowShell key={row.id}>
                                <RowFacts row={row} />
                                <div className="flex items-center gap-3 flex-wrap">
                                    <SetJobControl intakeId={row.id} jobs={jobs} currentProjectId={row.projectId} expectedState={row.state} expectedUpdatedAt={row.updatedAt} />
                                    <ReceiptLink storagePath={row.storagePath} />
                                    <VoidButton intakeId={row.id} expectedState={row.state} expectedUpdatedAt={row.updatedAt} />
                                </div>
                            </RowShell>
                        ))
                    )}
                </GroupCard>
            )}

            {groupIsVisible("needs-review", filters) && (
                <GroupCard title={RECEIPT_GROUP_LABELS["needs-review"]} count={counts["needs-review"]}>
                    {queue.needsReview.length === 0 ? (
                        <EmptyGroup message="Nothing here — nothing is waiting on a decision." />
                    ) : (
                        queue.needsReview.map(row => (
                            <RowShell key={row.id}>
                                <div className="min-w-[16rem]">
                                    <RowFacts row={row} />
                                    {(row.stateReason || row.lastError) && (
                                        <p className="text-xs text-amber-700 mt-1">{row.stateReason ?? row.lastError}</p>
                                    )}
                                    {row.postVoidQbPurchaseId && (
                                        <p className="text-xs font-medium text-red-700 mt-1">
                                            QuickBooks created a purchase for this AFTER it was voided. Nothing here can
                                            remove it — open it and void it in QuickBooks by hand.{" "}
                                            <a
                                                href={`https://qbo.intuit.com/app/expense?txnId=${encodeURIComponent(row.postVoidQbPurchaseId)}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="font-medium text-hui-primary hover:underline"
                                            >
                                                Open in QuickBooks ↗
                                            </a>
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-3 flex-wrap">
                                    <SetJobControl intakeId={row.id} jobs={jobs} currentProjectId={row.projectId} expectedState={row.state} expectedUpdatedAt={row.updatedAt} />
                                    <ReceiptLink storagePath={row.storagePath} />
                                    <MarkDuplicateControl intakeId={row.id} expectedState={row.state} expectedUpdatedAt={row.updatedAt} />
                                    {/* Only offered when a retry can actually
                                        do something. A document VERDICT
                                        (multi-doc, a duplicate, no estimate)
                                        needs a decision, not another attempt —
                                        the button would just park it again. */}
                                    {retryTargetFor(row.state, row.stateReason) && <RetryButton intakeId={row.id} expectedUpdatedAt={row.updatedAt} />}
                                    <VoidButton intakeId={row.id} expectedState={row.state} expectedUpdatedAt={row.updatedAt} />
                                </div>
                            </RowShell>
                        ))
                    )}
                </GroupCard>
            )}

            {groupIsVisible("booking", filters) && (
                <GroupCard title={RECEIPT_GROUP_LABELS.booking} count={counts.booking}>
                    {queue.booking.length === 0 ? (
                        <EmptyGroup message="Nothing here — nothing is mid-booking." />
                    ) : (
                        queue.booking.map(row => (
                            <RowShell key={row.id}>
                                <div className="min-w-[16rem]">
                                    <RowFacts row={row} />
                                    <p className="text-xs text-hui-textMuted mt-1">
                                        {row.stateReason ?? row.lastError ?? "Waiting for its turn"}
                                        {row.attempts > 0 && ` · attempt ${row.attempts}`}
                                        {row.nextRetryAt && ` · next try ${new Date(row.nextRetryAt).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}`}
                                    </p>
                                </div>
                                <div className="flex items-center gap-3 flex-wrap">
                                    <ReceiptLink storagePath={row.storagePath} />
                                    <RetryButton intakeId={row.id} expectedUpdatedAt={row.updatedAt} />
                                    <VoidButton intakeId={row.id} expectedState={row.state} expectedUpdatedAt={row.updatedAt} />
                                </div>
                            </RowShell>
                        ))
                    )}
                </GroupCard>
            )}

            {groupIsVisible("booked-today", filters) && (
                <GroupCard title={RECEIPT_GROUP_LABELS["booked-today"]} count={counts["booked-today"]}>
                    {queue.bookedToday.length === 0 ? (
                        <EmptyGroup message="Nothing here yet today." />
                    ) : (
                        queue.bookedToday.map(row => (
                            <RowShell key={row.id}>
                                <RowFacts row={row} />
                                <div className="flex items-center gap-3 flex-wrap">
                                    <ReceiptLink storagePath={row.storagePath} />
                                    {row.qbPurchaseId && <QuickBooksLink qbPurchaseId={row.qbPurchaseId} />}
                                </div>
                            </RowShell>
                        ))
                    )}
                </GroupCard>
            )}

            {groupIsVisible("missing-receipts", filters) && (
                <GroupCard title={RECEIPT_GROUP_LABELS["missing-receipts"]} count={counts["missing-receipts"]}>
                    {/* Owner filter — always rendered, so a filtered-to-empty
                        view still offers a way back out. */}
                    <div className="flex gap-2 flex-wrap items-center px-4 py-2 border-b border-slate-100">
                        <a href={filterHref({ owner: "" })} className={`text-xs font-medium ${filters.owner === null ? "text-hui-textMain" : "text-hui-primary hover:underline"}`}>
                            Everyone
                        </a>
                        {OWNER_ORDER.map(owner => (
                            <a
                                key={owner}
                                href={filterHref({ owner })}
                                className={`text-xs font-medium ${filters.owner === owner ? "text-hui-textMain" : "text-hui-primary hover:underline"}`}
                            >
                                {owner}
                            </a>
                        ))}
                    </div>
                    {/* The badge counts the WHOLE open queue (a count query, so a
                        backlog past the display cap can never read as small);
                        this says how much of it is on screen, so the two numbers
                        can always be reconciled. */}
                    {queue.counts.missingReceiptsShown !== queue.counts.missingReceipts && (
                        <p className="px-4 py-2 text-xs text-hui-textMuted border-b border-slate-100">
                            Showing {queue.counts.missingReceiptsShown} of {queue.counts.missingReceipts}
                            {filters.owner ? ` (filtered to ${filters.owner})` : " (oldest are shown first)"}.
                        </p>
                    )}
                    {missingByOwner.length === 0 ? (
                        <EmptyGroup message="Nothing here — every bank charge has a receipt." />
                    ) : (
                        missingByOwner.map(bucket => (
                            <div key={bucket.owner}>
                                <h3 className="px-4 py-2 text-xs font-semibold text-hui-textMain bg-slate-50 border-b border-slate-100">
                                    {bucket.owner}
                                    <span className="ml-2 font-normal text-hui-textMuted">{bucket.rows.length}</span>
                                </h3>
                                {bucket.owner === "unattributed" && (
                                    <p className="px-4 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
                                        No card tail on these, so nobody can be asked yet. Set whose charge each one was
                                        and it joins their card tomorrow morning.
                                    </p>
                                )}
                                {bucket.rows.map(row => <MissingReceiptRowView key={row.id} row={row} />)}
                            </div>
                        ))
                    )}
                </GroupCard>
            )}

            {groupIsVisible("duplicates", filters) && (
                <GroupCard title={RECEIPT_GROUP_LABELS.duplicates} count={counts.duplicates}>
                    {queue.duplicates.length === 0 ? (
                        <EmptyGroup message="Nothing here — no duplicates parked." />
                    ) : (
                        queue.duplicates.map(row => (
                            <RowShell key={row.id}>
                                <div className="min-w-[16rem]">
                                    <RowFacts row={row} />
                                    <p className="text-xs text-hui-textMuted mt-1">
                                        duplicate of <span className="font-mono">{row.duplicateOfId ?? "an unrecorded row"}</span>
                                    </p>
                                </div>
                                <div className="flex items-center gap-3 flex-wrap">
                                    <ReceiptLink storagePath={row.storagePath} />
                                    <NotADuplicateButton intakeId={row.id} expectedUpdatedAt={row.updatedAt} />
                                </div>
                            </RowShell>
                        ))
                    )}
                </GroupCard>
            )}
        </div>
    );
}

function MissingReceiptRowView({ row }: { row: MissingReceiptRow }) {
    return (
        <RowShell>
            <div className="min-w-[18rem]">
                <p className="text-sm text-hui-textMain font-medium">
                    {row.payee || row.rawDescriptor || "Unnamed charge"}
                    <span className="ml-2 font-normal tabular-nums">{amountLabel(row.amountCents)}</span>
                </p>
                <p className="text-xs text-hui-textMuted">
                    {row.postedDate || "date unknown"}
                    {row.cardTail ? ` · card …${row.cardTail}` : " · no card (office rail)"}
                </p>
                {row.resolution === "memo-signed" && (
                    <p className="text-xs text-teal-700 mt-1">
                        Memo signed
                        {row.pdfUrl && (
                            <>
                                {" · "}
                                <a href={row.pdfUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-hui-primary hover:underline">
                                    Open memo ↗
                                </a>
                            </>
                        )}
                    </p>
                )}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
                {row.owner === "unattributed" && <AssignOwnerControl issueId={row.id} currentOwner={row.owner} expectedVersion={row.version} />}
                {row.ownerAssigned && <span className="text-xs text-hui-textMuted">owner set by hand</span>}
                {row.threadName && <span className="text-xs text-hui-textMuted">asked in Chat</span>}
                {/* Reuses the register's mark-reviewed contract verbatim
                    ({id, version, reasonHash} → markReviewed) — ack writes are
                    never hand-rolled. */}
                <MarkReviewedButton
                    issue={{ id: row.id, version: row.version, reasonHash: row.reasonHash, acknowledged: row.acknowledged }}
                />
            </div>
        </RowShell>
    );
}
