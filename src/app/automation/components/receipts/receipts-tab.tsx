import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";
import { createRouteDeadline, type RouteDeadline } from "@/lib/quickbooks";
import { signReceiptDownloadUrls } from "@/lib/receipt-intake/bucket";
import { RECEIPT_URL_TTL_SECONDS } from "@/lib/receipt-intake/receipt-url";
import { retryTargetFor } from "@/lib/receipt-intake/route-state";
import { describeStateReason } from "@/lib/receipt-intake/reason-text";
import { isPossibleOrphanReason } from "@/lib/receipt-intake/park";
import { StatCard } from "../shared/stat-card";
import MarkReviewedButton from "../register/mark-reviewed-button";
import {
    RECEIPT_GROUPS,
    RECEIPT_GROUP_LABELS,
    OWNER_ORDER,
    groupIsVisible,
    showsTodoView,
    type ReceiptFilters,
    type ReceiptGroup,
} from "../../receipts-filters";
import type { IntakeRow, MissingReceiptRow, ReceiptQueue } from "../../receipts-data";
import {
    CHECK_GUIDE_HREF,
    PILE_AGE_MIN_DAYS,
    TODO_COPY,
    fillCopy,
    planTodo,
    rollUpDates,
    rollUpSummary,
    todoStoragePaths,
    type TodoPile,
    type TodoPlan,
    type TodoRequestItem,
} from "../../receipts-todo";
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

/**
 * Every date this tab prints is the crew's date.
 *
 * Vercel runs in UTC, so a bare `toLocaleString` puts an evening receipt on
 * tomorrow and a retry time hours off. receipts-data.ts already decides "booked
 * today" in this zone (`pacificDayStart`); the tab has to agree with it.
 */
const PACIFIC = "America/Los_Angeles";

/** A UTC instant as the crew's calendar day. Falls back to the raw prefix. */
function pacificDay(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso.slice(0, 10);
    return at.toLocaleDateString("en-CA", { timeZone: PACIFIC });
}

/**
 * Holds this page has words for. Anything else is quoted verbatim rather than
 * labelled as one of these, and mirrors KNOWN_HOLDS in receipts-todo.ts, which
 * decides the same question for the folded strip.
 */
const KNOWN_HOLD_VALUES: ReadonlySet<string> = new Set(["existing-evidence-review", "office-invoice"]);

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
                {row.txnDate ?? pacificDay(row.createdAt)} · {row.source}
                {row.projectName ? ` · ${row.projectName}` : ""}
            </p>
        </div>
    );
}

/**
 * One park reason in plain words, with the raw code still beside it.
 *
 * The sentence is what a bookkeeper acts on; the code is what a developer
 * greps, so both are drawn. A reason we have no words for answers with the code
 * as its own headline, which is why the span is conditional: it would otherwise
 * print the same token twice.
 */
function StateReason({ reason, row }: { reason: string | null; row: IntakeRow }) {
    const described = describeStateReason(reason, row);
    if (!described) return null;
    return (
        <>
            {described.headline}
            {described.raw !== described.headline && (
                <span className="ml-1.5 font-mono text-hui-textMuted">{described.raw}</span>
            )}
        </>
    );
}

/**
 * The signer this tab needs: one call, many paths, a map back.
 *
 * Injectable so a test can render the real tab against a recorded signer
 * rather than storage, the same seam bucket.ts offers its own callers.
 */
export type ReceiptBatchSigner = (
    storagePaths: readonly string[],
    ttlSeconds: number,
    deadline: RouteDeadline | undefined,
) => Promise<Map<string, string>>;

/**
 * How long a render will wait for its links, in total.
 *
 * The links are a convenience; the queue is the page. Without a shared budget
 * every batch is handed the storage helper's own fifteen-second allowance, so a
 * degraded storage day is minutes of blank page for a bookkeeper who only
 * wanted to see what is waiting. One budget covers the whole signing step, and
 * when it runs out the tab draws with the links it managed to get. Eight
 * seconds is far more than a healthy batch needs and far less than anyone will
 * wait for a page.
 */
export const RECEIPT_LINK_SIGN_BUDGET_MS = 8_000;

/** The groups whose rows carry an intake object, in render order. */
function linkedGroups(queue: ReceiptQueue): Array<[ReceiptGroup, IntakeRow[]]> {
    return [
        ["needs-job", queue.needsJob],
        ["needs-review", queue.needsReview],
        ["booking", queue.booking],
        ["booked-today", queue.bookedToday],
        ["duplicates", queue.duplicates],
    ];
}

/**
 * Every "Open receipt" href this render needs, in ONE round trip.
 *
 * A row's `storagePath` is the RAW object path inside the intake feature's own
 * PRIVATE bucket (`receipt-intake`). It is not a `receipt-intake://` reference
 * and not a `secure:` one, so resolveDocUrl cannot read it as it stands: a bare
 * path falls through to that function's legacy branch and comes back as a
 * PUBLIC `project-files` URL, which is the wrong bucket and a 404 for every row
 * on this tab (#443). Two things would resolve it, wrapping each path in a
 * `receipt-intake://` reference or signing it against the bucket it really
 * lives in. This signs, because the tab is holding every path already and the
 * batch call turns a page into one request instead of one per row.
 *
 * Only the groups `groupIsVisible` will draw: a filtered view must not pay to
 * sign rows it is not going to show.
 *
 * Never throws. With no answer from storage every row renders without a link,
 * which is exactly what a row with no signable object already does.
 */
async function signVisibleReceiptLinks(
    queue: ReceiptQueue,
    filters: ReceiptFilters,
    sign: ReceiptBatchSigner = signReceiptDownloadUrls,
): Promise<Map<string, string>> {
    const paths = [...new Set(
        linkedGroups(queue)
            .filter(([group]) => groupIsVisible(group, filters))
            .flatMap(([, rows]) => rows)
            .map(row => row.storagePath)
            .filter((path): path is string => !!path),
    )];
    return signPaths(paths, sign);
}

/**
 * The signing step itself: ONE batch, ONE budget, never throws.
 *
 * Split out so a caller can hand over exactly the paths it is going to draw.
 * The To-do view does that (`todoStoragePaths`), which is how "what we draw"
 * and "what we sign" are kept from answering differently, and is also why that
 * view signs a few dozen paths instead of five groups of a hundred.
 */
async function signPaths(
    paths: readonly string[],
    sign: ReceiptBatchSigner = signReceiptDownloadUrls,
): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    // Minted here, at call time, so every chunk of the batch shares ONE wall
    // clock rather than each starting a fresh allowance of its own.
    const deadline = createRouteDeadline(RECEIPT_LINK_SIGN_BUDGET_MS);
    try {
        return await sign(paths, RECEIPT_URL_TTL_SECONDS, deadline);
    } catch {
        return new Map();
    }
}

/**
 * "Open receipt" points at a short-lived signed URL for an object in the
 * private receipt-intake bucket, minted for the whole page at once by
 * signVisibleReceiptLinks. There is no public receipt URL to link to, and there
 * must not be one. A row whose object did not sign renders nothing rather than
 * a dead link.
 */
function ReceiptLink({ href }: { href: string | null | undefined }) {
    if (!href) return null;
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-hui-primary hover:underline">
            Open receipt ↗
        </a>
    );
}

/**
 * What these groups do and do not cover, and the way over to the register.
 *
 * Drawn by BOTH shapes of the tab. The claim it makes is narrow on purpose:
 * these counts are this intake queue, not "every receipt the company has", and
 * tests/receipt-queue-scope.test.ts fails the day that stops being true.
 */
function QueueScopeNote() {
    return (
        <p className="hui-card px-4 py-3 text-sm text-hui-textMuted">
            Needs job, Needs review, Booking and Booked today cover only receipts in this intake queue.
            Receipts handled through other email or photo paths may not appear in those totals.
            Missing receipts is a separate list of open requests for bank charges.{" "}
            <a href="/automation?tab=register" className="font-medium text-hui-primary hover:underline">
                View register
            </a>
            .
        </p>
    );
}

/**
 * The filter chips: Marge's list, then every group with its own count badge,
 * then the whole thing.
 *
 * Each group chip keeps the exact `?group=` href it has always had. "Everything"
 * is a real bookmarkable name for what a bare `?tab=receipts` used to draw, so
 * nobody loses a page by the default moving.
 */
function ReceiptChipRow({ filters, counts, filterHref, todo = false }: {
    filters: ReceiptFilters;
    counts: Record<ReceiptGroup, number>;
    filterHref: (overrides: { group?: string; owner?: string; view?: string }) => string;
    todo?: boolean;
}) {
    const chip = (active: boolean) =>
        `inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full transition ${
            active ? "bg-hui-primary text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
        }`;
    return (
        <div className="flex gap-2 flex-wrap items-center">
            <a href={filterHref({ group: "", owner: "", view: "todo" })} className={chip(todo)}>
                {TODO_COPY.chipTodo}
            </a>
            {RECEIPT_GROUPS.map(group => (
                <a key={group} href={filterHref({ group })} className={chip(filters.group === group)}>
                    {RECEIPT_GROUP_LABELS[group]}
                    <span className={`tabular-nums ${filters.group === group ? "text-white/80" : "text-slate-500"}`}>{counts[group]}</span>
                </a>
            ))}
            <a href={filterHref({ group: "", owner: "", view: "all" })} className={chip(!todo && filters.group === null)}>
                {TODO_COPY.chipEverything}
            </a>
        </div>
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

export async function ReceiptsTab({
    queue,
    filters,
    jobs,
    filterHref,
    nativeActive,
    sign,
}: {
    queue: ReceiptQueue;
    filters: ReceiptFilters;
    jobs: Array<{ id: string; name: string }>;
    filterHref: (overrides: { group?: string; owner?: string; view?: string }) => string;
    /**
     * Is ProBuild booking these itself? The SAME derivation the pause control
     * uses (`!pushEnabled && nativeBookingEnabled`), threaded in as a prop
     * rather than re-read here, so the two surfaces cannot name different
     * rails. With it on, nothing in this queue goes to QuickBooks.
     */
    nativeActive: boolean;
    /** Injected only by tests: a production render takes the real signer. */
    sign?: ReceiptBatchSigner;
}) {
    // Marge's list is the default shape of this tab, so the plan comes first:
    // in that shape the rows worth signing are exactly the ones it says will be
    // drawn, which is a few dozen rather than five groups of a hundred.
    const todo = showsTodoView(filters) ? planTodo(queue) : null;

    // ONE batched signing step for every row this render will draw, taken
    // before any of it is drawn, under ONE budget. Per-row signing here is five
    // hundred requests and five hundred Supabase clients on a page that is
    // force-dynamic, and unbudgeted it is a page that can hang on storage.
    const links = todo
        ? await signPaths(todoStoragePaths(todo), sign)
        : await signVisibleReceiptLinks(queue, filters, sign);

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

    if (todo) {
        return (
            <div className="space-y-6">
                <QueueScopeNote />
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                    <StatCard label={TODO_COPY.statNeedsYou} value={String(todo.needsYouCount)} sub={TODO_COPY.statNeedsYouSub} />
                    <StatCard label={TODO_COPY.statHandled} value={String(todo.handledCount)} sub={TODO_COPY.statHandledSub} />
                    <StatCard label={TODO_COPY.statBooked} value={String(counts["booked-today"])} sub={TODO_COPY.statBookedSub} />
                </div>
                <ReceiptChipRow filters={filters} counts={counts} filterHref={filterHref} todo />
                {/* "Done" is a claim about the WHOLE queue, and every list on
                    this page is capped at the same hundred rows with nothing
                    anywhere paging past it. Unloaded requests, or any group
                    that came back full, mean the empty piles are a display
                    limit rather than an empty inbox. */}
                {todo.needsYouCount === 0 && todo.notLoadedCount === 0 && todo.cappedGroups.length === 0
                    ? <TodoDone plan={todo} />
                    : todo.piles
                        .filter(pile => pile.items.length > 0)
                        .map(pile => <TodoPileCard key={pile.key} pile={pile} jobs={jobs} links={links} />)}
                {todo.notLoadedCount > 0 && (
                    <TodoCoverageNote
                        shown={queue.counts.missingReceiptsShown}
                        total={queue.counts.missingReceipts}
                        notLoaded={todo.notLoadedCount}
                    />
                )}
                <FoldedStrip plan={todo} filterHref={filterHref} />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <QueueScopeNote />
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                <StatCard label="Waiting on a person (intake queue)" value={String(counts["needs-job"] + counts["needs-review"])} sub="Queue receipts that need a job or a decision" />
                <StatCard
                    label="In flight (intake queue)"
                    value={String(counts.booking)}
                    sub={nativeActive
                        ? "Queue receipts booking into ProBuild job costing"
                        : "Queue receipts booking into QuickBooks"}
                />
                <StatCard label="Missing receipts" value={String(counts["missing-receipts"])} sub="Open receipt requests for bank charges" />
            </div>

            {/* Group filter chips, each carrying its own count badge. */}
            <ReceiptChipRow filters={filters} counts={counts} filterHref={filterHref} />

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
                                    {row.stateReason ? <> · <StateReason reason={row.stateReason} row={row} /></> : ""}
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
                        <EmptyGroup message="No receipts in this queue are waiting for a job." />
                    ) : (
                        queue.needsJob.map(row => (
                            <RowShell key={row.id}>
                                <RowFacts row={row} />
                                <div className="flex items-center gap-3 flex-wrap">
                                    <SetJobControl intakeId={row.id} jobs={jobs} currentProjectId={row.projectId} expectedState={row.state} expectedUpdatedAt={row.updatedAt} />
                                    <ReceiptLink href={links.get(row.storagePath)} />
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
                        <EmptyGroup message="No receipts in this queue are waiting on a decision." />
                    ) : (
                        queue.needsReview.map(row => (
                            <RowShell key={row.id}>
                                <div className="min-w-[16rem]">
                                    <RowFacts row={row} />
                                    {(row.stateReason || row.lastError) && (
                                        <p className="text-xs text-amber-700 mt-1">
                                            {row.stateReason
                                                ? <StateReason reason={row.stateReason} row={row} />
                                                : row.lastError}
                                        </p>
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
                                    <ReceiptLink href={links.get(row.storagePath)} />
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
                        <EmptyGroup message="No receipts in this queue are booking right now." />
                    ) : (
                        queue.booking.map(row => (
                            <RowShell key={row.id}>
                                <div className="min-w-[16rem]">
                                    <RowFacts row={row} />
                                    <p className="text-xs text-hui-textMuted mt-1">
                                        {row.stateReason
                                            ? <StateReason reason={row.stateReason} row={row} />
                                            : row.lastError ?? "Waiting for its turn"}
                                        {row.attempts > 0 && ` · attempt ${row.attempts}`}
                                        {row.nextRetryAt && ` · next try ${new Date(row.nextRetryAt).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short", timeZone: PACIFIC })}`}
                                    </p>
                                </div>
                                <div className="flex items-center gap-3 flex-wrap">
                                    <ReceiptLink href={links.get(row.storagePath)} />
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
                        <EmptyGroup message="No receipts from this queue have been booked yet today." />
                    ) : (
                        queue.bookedToday.map(row => (
                            <RowShell key={row.id}>
                                <RowFacts row={row} />
                                <div className="flex items-center gap-3 flex-wrap">
                                    <ReceiptLink href={links.get(row.storagePath)} />
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
                    {/* NEWEST, not oldest. The scan is
                        `orderBy: { firstObservedAt: "desc" }` and the in-memory
                        sort is newest first too (receipts-data.ts), so the old
                        "(oldest are shown first)" was backwards about the one
                        thing this line exists to explain. */}
                    {queue.counts.missingReceiptsShown !== queue.counts.missingReceipts && (
                        <p className="px-4 py-2 text-xs text-hui-textMuted border-b border-slate-100">
                            {fillCopy(filters.owner ? TODO_COPY.capLineOwner : TODO_COPY.capLine, {
                                shown: queue.counts.missingReceiptsShown,
                                total: queue.counts.missingReceipts,
                                owner: filters.owner ?? "",
                            })}
                        </p>
                    )}
                    {missingByOwner.length === 0 ? (
                        <EmptyGroup message="No open receipt requests in this view." />
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
                        <EmptyGroup message="No receipts in this queue are parked as duplicates." />
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
                                    <ReceiptLink href={links.get(row.storagePath)} />
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

/**
 * One pile of Marge's work: a title, one plain sentence saying what to do, and
 * the rows. Piles are drawn in the planner's order, which is "how few people
 * could possibly do this" rather than how big the pile is.
 */
function TodoPileCard({ pile, jobs, links }: {
    pile: TodoPile;
    jobs: Array<{ id: string; name: string }>;
    links: Map<string, string>;
}) {
    // Sub-headed by person only where the action is "ask this person". The
    // planner already ordered the items by OWNER_ORDER then by size, so this
    // just names each run as it starts.
    const showOwners = pile.key === "ask-for-these";
    let lastOwner: string | null = null;
    const rows: ReactNode[] = [];
    for (const item of pile.items) {
        if (showOwners && item.kind === "request" && item.item.owner !== lastOwner) {
            lastOwner = item.item.owner;
            rows.push(
                <h3 key={`owner-${lastOwner}`} className="px-4 py-2 text-xs font-semibold text-hui-textMain bg-slate-50 border-b border-slate-100">
                    {lastOwner}
                </h3>,
            );
        }
        rows.push(item.kind === "intake"
            ? <TodoIntakeRowView key={item.row.id} row={item.row} pile={pile.key} jobs={jobs} links={links} />
            : <TodoRequestItemView key={item.item.key} item={item.item} check={pile.key === "checks-and-sub-bills"} />);
    }

    return (
        <section className="hui-card overflow-hidden">
            <header className="px-4 py-3 border-b border-hui-border bg-slate-50">
                <div className="flex items-center gap-2">
                    <h2 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{pile.title}</h2>
                    <span className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 text-xs font-semibold rounded-full bg-white border border-slate-300 text-slate-700">
                        {pile.rowCount}
                    </span>
                </div>
                <p className="text-xs text-hui-textMuted mt-1">{pile.note}</p>
                {pile.oldestDays !== null && pile.oldestDays >= PILE_AGE_MIN_DAYS && (
                    <p className="text-xs text-amber-700 mt-1">{fillCopy(TODO_COPY.pileAge, { n: pile.oldestDays })}</p>
                )}
            </header>
            {rows}
        </section>
    );
}

/**
 * One receipt waiting on a person: the facts, why it is parked, one action.
 *
 * "Set job" is offered only where picking a job is what finishes the row. A
 * receipt nobody could read does not become readable by getting a job, so that
 * pile draws the link and nothing else. Void, Mark duplicate and Retry stay on
 * the group views: none of them is Marge's call.
 */
function TodoIntakeRowView({ row, pile, jobs, links }: {
    row: IntakeRow;
    pile: TodoPile["key"];
    jobs: Array<{ id: string; name: string }>;
    links: Map<string, string>;
}) {
    return (
        <RowShell>
            <div className="min-w-[16rem]">
                <RowFacts row={row} />
                {row.stateReason && (
                    <p className="text-xs text-amber-700 mt-1">
                        <StateReason reason={row.stateReason} row={row} />
                    </p>
                )}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
                {/* Only where picking a job is what finishes the row. A receipt
                    nobody could read does not become readable by getting a job,
                    and a row parked for a reason nobody has words for needs the
                    code passed on, not a guess acted on. */}
                {pile === "pick-the-job" && (
                    <SetJobControl intakeId={row.id} jobs={jobs} currentProjectId={row.projectId} expectedState={row.state} expectedUpdatedAt={row.updatedAt} />
                )}
                <ReceiptLink href={links.get(row.storagePath)} />
            </div>
        </RowShell>
    );
}

/**
 * One bank charge with no receipt behind it.
 *
 * A check says "check paid" rather than "no card (office rail)": the rail is
 * internal jargon, and on a check it is also the wrong fact to lead with. The
 * procedure is a LINK to the guide, never a restatement of it, so the row and
 * the guide cannot drift.
 */
function TodoRequestRowView({ row, check = false }: { row: MissingReceiptRow; check?: boolean }) {
    return (
        <RowShell>
            <div className="min-w-[18rem]">
                <p className="text-sm text-hui-textMain font-medium">
                    {row.payee || row.rawDescriptor || "Unnamed charge"}
                    <span className="ml-2 font-normal tabular-nums">{amountLabel(row.amountCents)}</span>
                </p>
                <p className="text-xs text-hui-textMuted">
                    {row.postedDate || "date unknown"}
                    {check
                        ? ` · ${TODO_COPY.checkFacts}`
                        : row.cardTail ? ` · card …${row.cardTail}` : ` · ${TODO_COPY.noCard}`}
                </p>
                {check && <p className="text-xs text-amber-700 mt-1">{TODO_COPY.checkSentence}</p>}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
                {/* BOTH unattributed and unassigned. setMissingReceiptOwner
                    (actions.ts) gates on target type, clearedAt and the
                    rendered version, and never on the current owner, so it
                    takes an unrecognised card tail exactly as it takes a
                    missing one. Without this the pile had a row nobody could
                    act on, which is worse than not listing it. */}
                {(row.owner === "unattributed" || row.owner === "unassigned") && (
                    <AssignOwnerControl issueId={row.id} currentOwner={row.owner} expectedVersion={row.version} />
                )}
                {check && (
                    <a href={CHECK_GUIDE_HREF} className="text-xs font-medium text-hui-primary hover:underline">
                        {TODO_COPY.checkLink}
                    </a>
                )}
                {/* The same ack write the register uses, unchanged. It means "I
                    asked, hide this until something changes": the row leaves
                    this list and is counted in the grey strip below. On a check
                    it means "I posted it", which is the same sentence. */}
                <MarkReviewedButton
                    issue={{ id: row.id, version: row.version, reasonHash: row.reasonHash, acknowledged: row.acknowledged }}
                />
            </div>
        </RowShell>
    );
}

/**
 * The same errand, repeated: one line instead of ten.
 *
 * A native `<details>`, so the expander needs no JavaScript, works in a server
 * component and is keyboard reachable for free. Children are ordinary rows,
 * oldest first, so opening it reads as a history. Each child keeps its own
 * "Mark reviewed": the ack is CAS-gated per row and there is no bulk write.
 */
function TodoRequestItemView({ item, check = false }: { item: TodoRequestItem; check?: boolean }) {
    if (item.rows.length === 1) return <TodoRequestRowView row={item.rows[0]} check={check} />;
    const oldestFirst = [...item.rows].sort((a, b) =>
        (a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1 : 0));
    return (
        <details className="border-b border-slate-100 last:border-b-0">
            <summary className="px-4 py-3 cursor-pointer">
                <span className="text-sm text-hui-textMain font-medium">
                    {item.payee || item.rows[0].rawDescriptor || "Unnamed charge"}
                    <span className="ml-2 font-normal tabular-nums">
                        {rollUpSummary(amountLabel(item.amountCentsEach), item.rows.length, amountLabel(item.totalCents))}
                    </span>
                </span>
                <span className="block text-xs text-hui-textMuted">
                    {check
                        ? `${item.firstDate || "date unknown"} to ${item.lastDate || "date unknown"} · ${TODO_COPY.checkFacts}`
                        : rollUpDates(item.firstDate || "date unknown", item.lastDate || "date unknown", item.rows[0].cardTail)}
                </span>
            </summary>
            <div className="border-t border-slate-100">
                {oldestFirst.map(row => <TodoRequestRowView key={row.id} row={row} check={check} />)}
            </div>
        </details>
    );
}

/**
 * What nobody has to do anything about, and who owns the rest.
 *
 * ALWAYS drawn, even at zero. A strip that only appears when there is bad news
 * is indistinguishable from a strip that broke. Every line links into the group
 * view that holds those rows, so one click is still the whole truth.
 */
function FoldedStrip({ plan, filterHref }: {
    plan: TodoPlan;
    filterHref: (overrides: { group?: string; owner?: string; view?: string }) => string;
}) {
    return (
        <section className="hui-card px-4 py-3 bg-slate-50">
            <p className="text-sm text-hui-textMuted">{fillCopy(TODO_COPY.stripHeader, { n: plan.handledCount })}</p>
            {(plan.folded.length > 0 || plan.cappedGroups.length > 0) && (
                <ul className="mt-2 space-y-1">
                    {/* Counts GROUPS, not rows, so it is deliberately not one
                        of the counted lines: adding it to handledCount would
                        break conservation. No link either, because no URL on
                        this page shows more than the same hundred. */}
                    {plan.cappedGroups.length > 0 && (
                        <li className="text-xs text-hui-textMuted">{TODO_COPY.cappedGroups}</li>
                    )}
                    {plan.folded.map(line => (
                        <li key={line.key} className="text-xs text-hui-textMuted">
                            {/* Built HERE, through the same builder the chips
                                use, so an active project filter survives the
                                click. The planner knows the group, not the URL. */}
                            <a
                                href={filterHref({ group: line.target.group, owner: line.target.owner ?? "" })}
                                className="font-medium text-hui-primary hover:underline"
                            >
                                {line.text}
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/**
 * What this view could not load.
 *
 * The request loader takes the newest 100 open items (receipts-data.ts), so on
 * a big backlog the piles are a window, not the queue. Saying so is the
 * difference between a short list and a short list that is lying.
 *
 * There is NO LINK here on purpose. Every view of this queue reads the same
 * capped hundred and nothing anywhere pages past it, so "open the full list"
 * would be a button that cannot do what it says. What is true is that the
 * window moves: a row leaves as it is answered, and the next one comes up.
 */
function TodoCoverageNote({ shown, total, notLoaded }: {
    shown: number;
    total: number;
    notLoaded: number;
}) {
    return (
        <section className="hui-card px-4 py-3">
            <p className="text-sm text-hui-textMuted">{fillCopy(TODO_COPY.capLine, { shown, total })}</p>
            <p className="text-sm text-hui-textMuted mt-1">
                {notLoaded === 1 ? TODO_COPY.notLoadedOne : fillCopy(TODO_COPY.notLoaded, { n: notLoaded })}
            </p>
        </section>
    );
}

/**
 * Nothing is waiting on her.
 *
 * It says what the system is holding rather than claiming the company is
 * finished: "every receipt has a job" would be a sentence this page cannot
 * know is true, and tests/receipt-queue-scope.test.tsx forbids it by name.
 */
function TodoDone({ plan }: { plan: TodoPlan }) {
    return (
        <section className="hui-card px-4 py-8 text-center">
            <p className="text-sm font-semibold text-hui-textMain">{TODO_COPY.doneTitle}</p>
            <p className="text-sm text-hui-textMuted mt-1">
                {plan.handledCount === 0
                    ? TODO_COPY.doneNothing
                    : plan.handledCount === 1
                        ? TODO_COPY.doneSubOne
                        : fillCopy(TODO_COPY.doneSub, { n: plan.handledCount })}
            </p>
        </section>
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
                {row.outreachHold && (
                    <p className="text-xs text-amber-700 mt-1">
                        {row.outreachHold === "office-invoice"
                            ? "Office invoice — collect from billing email. Crew request held."
                            : "Existing document needs reconciliation. Crew request held."}
                        {/* A hold this page has no words for was being LABELLED
                            as an evidence hold, which is a different claim. The
                            To-do strip links here by that raw value, so it has to
                            be findable once you arrive. */}
                        {!KNOWN_HOLD_VALUES.has(row.outreachHold) && (
                            <span className="ml-1.5 font-mono text-hui-textMuted">{row.outreachHold}</span>
                        )}
                    </p>
                )}
                {row.resolution !== null && row.resolution !== "memo-signed" && (
                    <p className="text-xs text-amber-700 mt-1">
                        Answered in a way this page has no words for.
                        <span className="ml-1.5 font-mono text-hui-textMuted">{row.resolution}</span>
                    </p>
                )}
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
