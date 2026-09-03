import { NextRequest, NextResponse } from "next/server";
import { getQBSettings } from "@/lib/integration-store";
import {
    syncEstimateToQB, syncInvoiceToQB,
    createRouteDeadline, isQBBudgetExhaustedError, isQBTimeoutError, isQboConnectionFailure,
    isQBAmbiguousDocumentCreateError,
    type QBTokens,
    type RouteDeadline,
} from "@/lib/quickbooks";
import { getFreshQBTokens, resolveCustomerAndItem } from "@/lib/quickbooks-payments";
import { AMBIGUOUS_CREATE_MARKER, CREATE_IN_FLIGHT_MARKER, parseCreateMarker } from "@/lib/qbo-create-markers";
import {
    composeSyncMarker,
    identityMatchesMarker,
    loadDocumentIdentity,
    probeDocumentSync,
    syncMarkerIdentity,
    syncMarkerKind,
    syncRequestId,
    type DocumentIdentityFacts,
} from "@/lib/qbo-document-sync";
import { withTxRetry, lockMoneyParents } from "@/lib/tx-retry";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { toNum } from "@/lib/prisma-helpers";
import { currentStaffUserOrNull, hasPermission, canAccessProject, canAccessEstimate } from "@/lib/permissions";

/**
 * Whole-request budget. This route makes a serial CHAIN of QuickBooks calls —
 * token refresh, customer ensure, service-item ensure, then the document sync —
 * and every one of them used to be unbounded. During the 2026-09-01 outage that
 * is exactly how a single request sat until the platform killed it: four calls
 * that are each individually legal still add up past the ceiling.
 */
const QB_SYNC_BUDGET_MS = 50_000;

export const maxDuration = 60;

// A byte-for-byte copy of `resolveCustomerAndItem` used to live here. It has
// been deleted rather than fixed: re-pointing `Client.qbCustomerId` is a
// money-path write that must take the canonical Client row lock (see
// tx-retry.ts), and a second copy of that rule is a second place for it to be
// forgotten. There is now exactly one writer of that column.

/**
 * DOCUMENT-SYNC IDEMPOTENCY, and why this route needed its own.
 *
 * It used to create a QuickBooks estimate or invoice, hand the id back in the
 * response, and persist NOTHING. Three consequences, all real:
 *
 *   • a second sync of the same record made a SECOND QuickBooks document —
 *     nothing was ever checked;
 *   • the `retry: false` on an ambiguous 503 is advice to a client, not a
 *     constraint. A refresh, a double-click, or a user who simply tries again
 *     re-POSTs, and QuickBooks has no reason to refuse it;
 *   • nothing in ProBuild pointed at either document afterwards, so nobody
 *     could even find the duplicate to remove it.
 *
 * The milestone rail solved this years of incidents ago and this now uses the
 * same three parts, in the same order:
 *
 *   1. REFUSE when already linked — return the id we hold, 200, no POST.
 *   2. CLAIM before the POST: CAS a `create-in-flight` marker onto the record.
 *      A crash after this point is visible; a row already carrying a marker is
 *      refused rather than re-sent.
 *   3. PERSIST in the write that clears the marker, so "linked" and "not
 *      claimed" can never disagree.
 *
 * Plus the one thing the milestone rail has no equivalent for: a stable QBO
 * `requestid`. Intuit dedupes on it server-side, so a replay carrying the same
 * marker nonce gets the ORIGINAL document back instead of a new one.
 */
/**
 * A claimed record, re-examined instead of refused forever.
 *
 * The first cut simply refused any stored marker and told the operator to
 * "record its id" or "clear the marker" — neither of which is a thing anyone can
 * do: nothing in the product reads or writes that column by hand. So a process
 * death anywhere after the claim, INCLUDING BEFORE THE POST EVER WENT OUT,
 * bricked sync for that record permanently.
 *
 * Now the claim is a question, not a verdict: ask QuickBooks whether the
 * document is there.
 *
 *   • found   — adopt it. Persist the id and clear the marker, one CAS.
 *   • absent  — KEEP the claim and go on to create, reusing this marker's
 *              nonce so the create carries the SAME requestid. That matters: if
 *              the document did exist but the query had not indexed it yet,
 *              Intuit's dedupe returns the original rather than making a
 *              second. Clearing the marker and claiming a fresh nonce would
 *              have thrown that protection away at the exact moment it counts.
 *   • unknown — still refuse, with a retry-later status, and leave the marker
 *              for the maintenance sweep to try again.
 */
/**
 * PAYLOAD IDENTITY, and why the claim had to grow one.
 *
 * The claim used to pin `(id, qbId null, marker null)` and nothing else, and
 * the finalize write pinned only the marker. Between them sit a token refresh,
 * a customer resolve and the document create — seconds of remote calls. An
 * edit landing in that window (a line added or repriced, the title rewritten,
 * the project renamed, the client re-pointed at another QuickBooks customer)
 * left the record LINKED to a QuickBooks document describing something else,
 * with nothing anywhere recording the divergence.
 *
 * So the claim now records a fingerprint of the exact payload it is about to
 * send (`loadDocumentIdentity`), taken under the canonical
 * Estimate → Invoice → Client locks so the customer it reads cannot be remapped
 * mid-decision, and the finalize CAS re-reads and re-computes it. Same shape as
 * the milestone rail, whose marker has carried an issuance hash since round 33.
 */

/**
 * THE decision primitive. Every adopt, replay, finalize and fresh claim on
 * this rail goes through it, and none of them re-derives its own subset of
 * columns.
 *
 * Rounds 39, 40 and 41 each found the same bug in a different place: a
 * decision comparing SOME of the state and missing whichever field the next
 * reviewer thought of — the customer, then the line items, then the project
 * association and the code. So this takes the canonical money locks
 * (Estimate → Invoice → Client), recomputes the WHOLE payload identity from the
 * database inside them (`loadDocumentIdentity`), optionally compares it to what
 * the marker recorded (`identityMatchesMarker`), and only then runs the write.
 *
 * The Client lock is FOR SHARE: this reads the mapping, but must not straddle
 * the FOR UPDATE remap in `resolveCustomerAndItem`, which may have run moments
 * ago on this very request.
 */
async function decideUnderIdentity<T>(args: {
    kind: "estimate" | "invoice";
    id: string;
    clientId: string;
    /** When set, the current identity must still equal what this claim recorded. */
    expectMarker?: string;
    /**
     * When set, the customer read under the lock must be this one.
     *
     * A fresh claim passes what `resolveCustomerAndItem` just answered. If the
     * locked read disagrees, the mapping moved between that call and this
     * decision — and the payload is built from the resolved value, so proceeding
     * would send an invoice to one customer while recording another. Fail
     * closed; the retry resolves against the mapping that now stands.
     */
    expectCustomerId?: string;
    decide: (tx: Prisma.TransactionClient, facts: DocumentIdentityFacts) => Promise<T>;
}): Promise<{ ok: true; value: T; facts: DocumentIdentityFacts } | { ok: false; reason: string }> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(
            tx,
            {
                estimateId: args.kind === "estimate" ? args.id : null,
                invoiceId: args.kind === "invoice" ? args.id : null,
                clientId: args.clientId,
            },
            { clientLock: "share" },
        );
        const facts = await loadDocumentIdentity(tx, args.kind, args.id);
        if (!facts) {
            return { ok: false as const, reason: "it no longer has a client and project to bill" };
        }
        if (args.expectCustomerId && facts.customerId !== args.expectCustomerId) {
            return { ok: false as const, reason: "its QuickBooks customer changed while this was being prepared" };
        }
        if (args.expectMarker) {
            const verdict = identityMatchesMarker(facts, args.expectMarker);
            if (!verdict.ok) return { ok: false as const, reason: verdict.reason };
        }
        return { ok: true as const, value: await args.decide(tx, facts), facts };
    }));
}

/** Compose the claim marker for a set of freshly computed facts. */
function markerFor(facts: DocumentIdentityFacts, tokens: QBTokens, at: Date): string {
    return composeSyncMarker(
        CREATE_IN_FLIGHT_MARKER,
        {
            docNumber: facts.docNumber,
            privateNote: facts.privateNote,
            issuanceHash: facts.hash,
            expectedTotal: facts.total,
            realmId: tokens.realmId,
            customerId: facts.customerId,
        },
        at,
    );
}

type RecoveryOutcome =
    | { kind: "adopted"; response: NextResponse }
    | { kind: "create"; marker: string; facts: DocumentIdentityFacts }
    | { kind: "refused"; response: NextResponse };

/**
 * A claim that cannot be resolved automatically, because the record no longer
 * matches what was sent.
 *
 * Distinct from `retryLater`: retrying will not help, and saying "try again
 * shortly" about a state only a human can settle is how an operator ends up
 * pressing a button forever. 409, with the QuickBooks id when one is known.
 */
function parked(code: string, reason: string, qbId: string | null) {
    return NextResponse.json(
        {
            error:
                `${code} has a QuickBooks document waiting on it, but ${reason}. ` +
                `Open it in QuickBooks and reconcile it by hand — ProBuild will not link or re-send it automatically.`,
            retry: false,
            reason: "identity-mismatch",
            ...(qbId ? { qbId } : {}),
        },
        { status: 409 },
    );
}

function retryLater(code: string, reason: string) {
    return NextResponse.json(
        {
            error:
                `A previous QuickBooks sync for ${code} could not be confirmed (${reason}), so nothing was sent. ` +
                `ProBuild will keep checking; try again shortly.`,
            retry: true,
            reason: "ambiguous-create",
        },
        { status: 503 },
    );
}

async function recoverClaimedRecord(args: {
    kind: "estimate" | "invoice";
    id: string;
    code: string;
    clientId: string;
    marker: string;
    tokens: QBTokens;
    deadline: RouteDeadline;
    /** Adopt: persist the id and clear the marker in ONE compare-and-set. */
    adopt: (tx: Prisma.TransactionClient, qbId: string) => Promise<{ count: number }>;
    /** Re-claim: put the marker back to create-in-flight, same identity. */
    reclaim: (tx: Prisma.TransactionClient, next: string) => Promise<{ count: number }>;
    urlFor: (qbId: string) => string;
    /** The original claim time, preserved so the marker keeps one identity. */
    claimedAt: Date;
}): Promise<RecoveryOutcome> {
    // Everything the probe compares comes from the MARKER, not from how the
    // record looks now: the record may well have been edited since the create,
    // and re-deriving the identity from current state would ask QuickBooks
    // about a document we never sent.
    const probe = await probeDocumentSync(
        args.tokens,
        { kind: args.kind, marker: args.marker },
        args.deadline,
    );

    if (probe.state === "unknown") {
        return { kind: "refused", response: retryLater(args.code, probe.reason) };
    }

    if (probe.state === "found") {
        // ADOPTION IS AN IDENTITY DECISION, not just a CAS on the marker. The
        // document in QuickBooks describes the record as it was WHEN THE CREATE
        // WENT OUT; if the record has been edited since, linking it would attach
        // a stale document to changed money. Recomputed under the locks and
        // compared to the claim — a mismatch parks rather than adopts.
        const adopted = await decideUnderIdentity({
            kind: args.kind, id: args.id, clientId: args.clientId, expectMarker: args.marker,
            decide: (tx) => args.adopt(tx, probe.qbId),
        });
        if (!adopted.ok) return { kind: "refused", response: parked(args.code, adopted.reason, probe.qbId) };
        if (adopted.value.count !== 1) {
            // Somebody else finished it between the probe and this write. Not an
            // error, but not ours to report either — re-read rather than assert.
            return { kind: "refused", response: retryLater(args.code, "it was being updated concurrently") };
        }
        return {
            kind: "adopted",
            response: NextResponse.json({
                success: true,
                qbId: probe.qbId,
                qbUrl: args.urlFor(probe.qbId),
                recovered: true,
            }),
        };
    }

    // Absent. Re-claim carrying the SAME identity, so the create below replays
    // the requestid the previous attempt would have sent: if the document did
    // exist but the query index had not caught up, Intuit returns the original
    // rather than making a second. A fresh identity would have thrown that
    // protection away at the exact moment it counts.
    const identity = syncMarkerIdentity(args.marker);
    if (!identity) {
        return { kind: "refused", response: retryLater(args.code, "its claim could not be read") };
    }
    // REPLAY IS AN IDENTITY DECISION TOO. Reusing the old claim means reusing
    // its requestid, which is only safe while the payload is still the one that
    // claim describes — otherwise the replay would send NEW content under the
    // OLD identity, and Intuit dedupe could hand back the old document for it.
    const next = composeSyncMarker(CREATE_IN_FLIGHT_MARKER, identity, args.claimedAt);
    const reclaimed = await decideUnderIdentity({
        kind: args.kind, id: args.id, clientId: args.clientId, expectMarker: args.marker,
        decide: (tx) => args.reclaim(tx, next),
    });
    if (!reclaimed.ok) return { kind: "refused", response: parked(args.code, reclaimed.reason, null) };
    if (reclaimed.value.count !== 1) {
        return { kind: "refused", response: retryLater(args.code, "it was being updated concurrently") };
    }
    return { kind: "create", marker: next, facts: reclaimed.facts };
}

/**
 * What the claim becomes when the create did not return a document.
 *
 * The distinction is the whole point of the marker, and it is exactly the one
 * the milestone rail draws:
 *
 *   • QuickBooks ANSWERED and refused — nothing was created, so the claim is
 *     released and the record is freely re-syncable;
 *   • the outcome is UNKNOWN (a timeout after dispatch, a 2xx we could not
 *     read, a 4xx with no readable Fault) — a real document may exist. The
 *     claim is promoted to `ambiguous-create`, KEEPING the same nonce so the
 *     recovery above can replay the same requestid, and every further sync goes
 *     through that recovery instead of creating.
 *
 * Never throws: this runs while an error is already propagating, and losing
 * the original failure to a bookkeeping write would be strictly worse.
 */
async function settleSyncMarker(
    write: (data: { qbSyncMarker: string | null }) => Promise<{ count: number }>,
    marker: string,
    error: unknown,
): Promise<void> {
    const ambiguous = isQBAmbiguousDocumentCreateError(error);
    const parsed = parseCreateMarker(marker);
    const identity = parsed?.identity ?? null;
    const claimedAt = new Date(parsed?.atMs ?? Date.now());
    try {
        await write({
            // Promoted, not re-derived: the SAME identity and the SAME claim
            // time, so the recovery still knows exactly which document to ask
            // about and the replayed requestid stays the one that was sent.
            qbSyncMarker: ambiguous && identity
                ? composeSyncMarker(AMBIGUOUS_CREATE_MARKER, identity, claimedAt)
                : null,
        });
    } catch {
        // Best effort. A lost RELEASE leaves the record going through recovery on
        // the next sync, which is the safe direction; a lost PROMOTION leaves the
        // in-flight marker, which recovers the same way.
    }
}

export async function POST(req: NextRequest) {
    // ONE budget for the request, created at the entry and threaded through
    // every QuickBooks call below.
    const deadline = createRouteDeadline(QB_SYNC_BUDGET_MS);
    try {
        const { type, id } = await req.json();

        if (!type || !id) {
            return NextResponse.json({ error: "type and id required" }, { status: 400 });
        }
        if (type !== "estimate" && type !== "invoice") {
            return NextResponse.json({ error: "Unknown type" }, { status: 400 });
        }

        // In-handler authorization. The proxy in front of this route proves the
        // request came through the app, not that THIS caller may sync THIS
        // record — checked before any token fetch or QuickBooks call, so an
        // unauthorized request never spends a QBO round trip.
        const user = await currentStaffUserOrNull();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        if (!hasPermission(user, type === "estimate" ? "estimates" : "invoices")) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        if (type === "estimate") {
            const estimate = await prisma.estimate.findUnique({
                where: { id },
                select: {
                    id: true, code: true, title: true, status: true,
                    qbEstimateId: true, qbSyncMarker: true, itemsRevision: true,
                    totalAmount: true, balanceDue: true, createdAt: true, projectId: true, leadId: true,
                    // id/parentId feed the section-header detection in `buildQBEstimateLines`.
                    // orderBy keeps QB LineNum in the estimate's own row order rather than
                    // whatever order Postgres happens to return.
                    items: {
                        orderBy: [{ order: "asc" }, { id: "asc" }],
                        select: { id: true, parentId: true, name: true, quantity: true, unitCost: true, total: true, type: true },
                    },
                    project: { include: { client: true } },
                },
            });
            if (!estimate) return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
            if (!canAccessEstimate(user, { projectId: estimate.projectId, leadId: estimate.leadId })) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }

            // 1. Already linked: the answer is the id we hold. Idempotent 200,
            //    and no QuickBooks call at all — not even a token refresh.
            if (estimate.qbEstimateId) {
                return NextResponse.json({
                    success: true,
                    qbId: estimate.qbEstimateId,
                    qbUrl: `https://app.qbo.intuit.com/app/estimate?txnId=${estimate.qbEstimateId}`,
                    alreadyLinked: true,
                });
            }

            const client = estimate.project?.client;
            if (!client) return NextResponse.json({ error: "No client attached to estimate" }, { status: 400 });

            const qb = await getQBSettings();
            if (!qb.connected) {
                return NextResponse.json({ error: "QuickBooks not connected", notConnected: true }, { status: 400 });
            }
            const tokens = await getFreshQBTokens(deadline);

            const { customerId, itemId } = await resolveCustomerAndItem(tokens, client.id, deadline);

            // 2. RECOVER an existing claim, or CLAIM afresh.
            //
            //    A stored marker means an earlier attempt did not finish. That
            //    is not proof a document exists, so it is answered by ASKING
            //    QuickBooks rather than by refusing the record forever.
            //
            //    A fresh claim is CAS-pinned to "still unlinked, still
            //    unclaimed", so a concurrent sync loses instead of racing this
            //    one into two documents. Failing to WRITE it aborts — an
            //    unwritten marker is exactly the invisible-crash case it guards.
            const estimateUrl = (qbId: string) => `https://app.qbo.intuit.com/app/estimate?txnId=${qbId}`;
            // The PrivateNote the create will write, and what proves the document
            // is ours at recovery time. It carries the code as well as the title,
            // because a title alone is something any document could have.
            let estimateMarker: string;
            let estimateFacts: DocumentIdentityFacts;
            let estimateClaimedAt = new Date();
            if (syncMarkerKind(estimate.qbSyncMarker)) {
                const stored = estimate.qbSyncMarker as string;
                estimateClaimedAt = new Date(parseCreateMarker(stored)?.atMs ?? Date.now());
                const recovery = await recoverClaimedRecord({
                    kind: "estimate", id: estimate.id, code: estimate.code, clientId: client.id,
                    marker: stored, tokens, deadline, claimedAt: estimateClaimedAt,
                    adopt: (tx, qbId) => tx.estimate.updateMany({
                        where: { id: estimate.id, qbEstimateId: null, qbSyncMarker: stored },
                        data: { qbEstimateId: qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
                    }),
                    reclaim: (tx, next) => tx.estimate.updateMany({
                        where: { id: estimate.id, qbEstimateId: null, qbSyncMarker: stored },
                        data: { qbSyncMarker: next },
                    }),
                    urlFor: estimateUrl,
                });
                if (recovery.kind !== "create") return recovery.response;
                estimateMarker = recovery.marker;
                // The replay reuses the OLD identity, and the recovery above only
                // let it through because the record still matches it.
                estimateFacts = recovery.facts;
            } else {
                //    Claimed UNDER the money locks (Estimate → Invoice → Client), and
                //    the identity is recomputed from the database INSIDE them rather
                //    than from the read at the top of this handler:
                //    `resolveCustomerAndItem` may have remapped Client.qbCustomerId
                //    moments ago, and an edit may have landed since.
                const claimed = await decideUnderIdentity({
                    kind: "estimate", id: estimate.id, clientId: client.id, expectCustomerId: customerId,
                    decide: async (tx, facts) => {
                        const marker = markerFor(facts, tokens, estimateClaimedAt);
                        const written = await tx.estimate.updateMany({
                            where: { id: estimate.id, qbEstimateId: null, qbSyncMarker: null },
                            data: { qbSyncMarker: marker },
                        });
                        return { marker, count: written.count };
                    },
                });
                if (!claimed.ok) return retryLater(estimate.code, claimed.reason);
                if (claimed.value.count !== 1) {
                    return retryLater(estimate.code, "another sync claimed it first");
                }
                estimateMarker = claimed.value.marker;
                estimateFacts = claimed.facts;
            }

            const result = await syncEstimateToQB(tokens, {
                id: estimate.id,
                code: estimate.code,
                title: estimate.title,
                totalAmount: toNum(estimate.totalAmount),
                // Passed through whole — `syncEstimateToQB` drops section headers itself, so the
                // hierarchy fields have to survive this mapping.
                items: estimate.items.map(i => ({
                    id: i.id,
                    parentId: i.parentId,
                    name: i.name,
                    quantity: i.quantity,
                    unitCost: toNum(i.unitCost),
                    total: toNum(i.total),
                    type: i.type,
                })),
                // From the verified facts, so what is billed is what the claim
                // recorded — the two cannot drift apart.
                customerId: estimateFacts.customerId,
                itemId,
                project: estimate.project ? { name: estimate.project.name } : null,
                // The canonical marker note, not the bare title: this is what a
                // recovery matches on to prove the document is ours. Taken from
                // the VERIFIED facts, so what is sent is what the claim recorded.
                privateNote: estimateFacts.privateNote,
            }, qb.glMappings || {}, deadline, syncRequestId(estimate.id, estimateMarker))
                .catch(async (error) => {
                    await settleSyncMarker(
                        (data) => prisma.estimate.updateMany({ where: { id: estimate.id, qbSyncMarker: estimateMarker }, data }),
                        estimateMarker,
                        error,
                    );
                    throw error;
                });

            // 3. PERSIST in the same write that clears the claim, pinned to it,
            //    so the id and the marker can never disagree.
            //    Finalization is the SAME identity decision as adoption, so it uses
            //    the same helper: locks, recompute the whole payload identity from
            //    the database, compare it to what the claim recorded, and only then
            //    write. Pinning a hand-picked list of columns was how the customer,
            //    then the line items, then the project association each turned out
            //    to be missing from it one round after another.
            const estimatePersisted = await decideUnderIdentity({
                kind: "estimate", id: estimate.id, clientId: client.id, expectMarker: estimateMarker,
                decide: (tx) => tx.estimate.updateMany({
                    where: { id: estimate.id, qbEstimateId: null, qbSyncMarker: estimateMarker },
                    data: { qbEstimateId: result.qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
                }),
            });
            if (!estimatePersisted.ok || estimatePersisted.value.count !== 1) {
                // The document EXISTS in QuickBooks and this record no longer
                // carries our claim, so it cannot be reported as a clean
                // success. Say what was created and where; the next sync
                // recovers it by DocNumber rather than making a second.
                return NextResponse.json(
                    {
                        error:
                            `QuickBooks created ${estimate.code} (id ${result.qbId}), but ` +
                            `${estimatePersisted.ok ? "it changed" : estimatePersisted.reason} while that was in ` +
                            `flight, so the link was not recorded. Reconcile it in QuickBooks.`,
                        retry: false,
                        qbId: result.qbId,
                    },
                    { status: 409 },
                );
            }

            return NextResponse.json({ success: true, qbId: result.qbId, qbUrl: result.qbUrl });
        }

        const invoice = await prisma.invoice.findUnique({
            where: { id },
            include: {
                client: true,
                project: true,
            },
        });
        if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
        if (!canAccessProject(user, invoice.projectId)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        // Same three parts as the estimate branch above.
        if (invoice.qbInvoiceId) {
            return NextResponse.json({
                success: true,
                qbId: invoice.qbInvoiceId,
                qbUrl: `https://app.qbo.intuit.com/app/invoice?txnId=${invoice.qbInvoiceId}`,
                alreadyLinked: true,
            });
        }
        const qb = await getQBSettings();
        if (!qb.connected) {
            return NextResponse.json({ error: "QuickBooks not connected", notConnected: true }, { status: 400 });
        }
        const tokens = await getFreshQBTokens(deadline);

        const { customerId, itemId } = await resolveCustomerAndItem(tokens, invoice.client.id, deadline);

        const invoiceUrl = (qbId: string) => `https://app.qbo.intuit.com/app/invoice?txnId=${qbId}`;
        // The invoice create used to send NO PrivateNote at all, which left its
        // recovery matching on DocNumber alone — and QuickBooks does not enforce
        // DocNumber uniqueness, so a hand-created or imported invoice sharing the
        // code would have been adopted. It now carries the same canonical marker
        // note the estimate rail does, taken from the verified facts.
        let invoiceMarker: string;
        let invoiceFacts: DocumentIdentityFacts;
        let invoiceClaimedAt = new Date();
        if (syncMarkerKind(invoice.qbSyncMarker)) {
            const stored = invoice.qbSyncMarker as string;
            invoiceClaimedAt = new Date(parseCreateMarker(stored)?.atMs ?? Date.now());
            const recovery = await recoverClaimedRecord({
                kind: "invoice", id: invoice.id, code: invoice.code, clientId: invoice.client.id,
                marker: stored, tokens, deadline, claimedAt: invoiceClaimedAt,
                adopt: (tx, qbId) => tx.invoice.updateMany({
                    where: { id: invoice.id, qbInvoiceId: null, qbSyncMarker: stored },
                    data: { qbInvoiceId: qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
                }),
                reclaim: (tx, next) => tx.invoice.updateMany({
                    where: { id: invoice.id, qbInvoiceId: null, qbSyncMarker: stored },
                    data: { qbSyncMarker: next },
                }),
                urlFor: invoiceUrl,
            });
            if (recovery.kind !== "create") return recovery.response;
            invoiceMarker = recovery.marker;
            invoiceFacts = recovery.facts;
        } else {
            const claimed = await decideUnderIdentity({
                kind: "invoice", id: invoice.id, clientId: invoice.client.id, expectCustomerId: customerId,
                decide: async (tx, facts) => {
                    const marker = markerFor(facts, tokens, invoiceClaimedAt);
                    const written = await tx.invoice.updateMany({
                        where: { id: invoice.id, qbInvoiceId: null, qbSyncMarker: null },
                        data: { qbSyncMarker: marker },
                    });
                    return { marker, count: written.count };
                },
            });
            if (!claimed.ok) return retryLater(invoice.code, claimed.reason);
            if (claimed.value.count !== 1) {
                return retryLater(invoice.code, "another sync claimed it first");
            }
            invoiceMarker = claimed.value.marker;
            invoiceFacts = claimed.facts;
        }

        const result = await syncInvoiceToQB(tokens, {
            code: invoice.code,
            totalAmount: toNum(invoice.totalAmount),
            balanceDue: toNum(invoice.balanceDue),
            customerId: invoiceFacts.customerId,
            itemId,
            project: invoice.project ? { name: invoice.project.name } : null,
            privateNote: invoiceFacts.privateNote,
        }, deadline, syncRequestId(invoice.id, invoiceMarker))
            .catch(async (error) => {
                await settleSyncMarker(
                    (data) => prisma.invoice.updateMany({ where: { id: invoice.id, qbSyncMarker: invoiceMarker }, data }),
                    invoiceMarker,
                    error,
                );
                throw error;
            });

        // The same identity decision as the estimate rail, through the same
        // helper: locks, recompute the whole payload identity, compare it to the
        // claim, and only then link.
        const invoicePersisted = await decideUnderIdentity({
            kind: "invoice", id: invoice.id, clientId: invoice.client.id, expectMarker: invoiceMarker,
            decide: (tx) => tx.invoice.updateMany({
                where: { id: invoice.id, qbInvoiceId: null, qbSyncMarker: invoiceMarker },
                data: { qbInvoiceId: result.qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
            }),
        });
        if (!invoicePersisted.ok || invoicePersisted.value.count !== 1) {
            return NextResponse.json(
                {
                    error:
                        `QuickBooks created ${invoice.code} (id ${result.qbId}), but ` +
                        `${invoicePersisted.ok ? "it changed" : invoicePersisted.reason} while that was in ` +
                        `flight, so the link was not recorded. Reconcile it in QuickBooks.`,
                    retry: false,
                    qbId: result.qbId,
                },
                { status: 409 },
            );
        }

        return NextResponse.json({ success: true, qbId: result.qbId, qbUrl: result.qbUrl });
    } catch (err) {
        // The create POST may already have reached QuickBooks — a timeout or
        // transport failure AFTER dispatch, or a 2xx response missing the
        // created document's id (see syncEstimateToQB / syncInvoiceToQB).
        // Retrying blindly risks a duplicate, so this is reported distinctly
        // from an ordinary outage and never advertises retry:true.
        if (isQBAmbiguousDocumentCreateError(err)) {
            return NextResponse.json(
                {
                    error: "QuickBooks did not confirm whether this document was created — check QuickBooks for it before retrying.",
                    retry: false,
                    reason: "ambiguous-create",
                },
                { status: 503 },
            );
        }
        // Out of budget, or QuickBooks unreachable BEFORE the create was
        // dispatched (token refresh, customer/item lookup): 503 + retry, not
        // a 500. The caller should come back rather than treat an outage as a
        // rejected document.
        if (isQBBudgetExhaustedError(err) || isQboConnectionFailure(err)) {
            return NextResponse.json(
                { error: isQBTimeoutError(err) ? "QuickBooks did not respond in time" : "QuickBooks is unavailable", retry: true },
                { status: 503 },
            );
        }
        const msg = err instanceof Error ? err.message : "Sync failed";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
