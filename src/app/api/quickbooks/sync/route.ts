import { NextRequest, NextResponse } from "next/server";
import { getQBSettings } from "@/lib/integration-store";
import {
    syncEstimateToQB, syncInvoiceToQB,
    createRouteDeadline, isQBBudgetExhaustedError, isQBTimeoutError, isQboConnectionFailure,
    isQBAmbiguousDocumentCreateError,
    QB_DOC_NUMBER_MAX_LEN,
    type QBTokens,
    type RouteDeadline,
} from "@/lib/quickbooks";
import { getFreshQBTokens, resolveCustomerAndItem } from "@/lib/quickbooks-payments";
import { AMBIGUOUS_CREATE_MARKER, CREATE_IN_FLIGHT_MARKER, parseCreateMarker } from "@/lib/qbo-create-markers";
import {
    composeSyncMarker,
    documentPrivateNote,
    probeDocumentSync,
    syncMarkerIdentity,
    syncMarkerKind,
    syncRequestId,
} from "@/lib/qbo-document-sync";
import { documentIssuanceHash } from "@/lib/qbo-issuance";
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
 * send (`documentIssuanceHash`), taken under the canonical
 * Estimate → Invoice → Client locks so the customer it reads cannot be remapped
 * mid-decision, and the finalize CAS re-reads and re-computes it. Same shape as
 * the milestone rail, whose marker has carried an issuance hash since round 33.
 */
interface DocumentPayloadIdentity {
    hash: string;
    docNumber: string;
    privateNote: string;
    total: number;
    customerId: string;
    /** Estimates only: the canonical optimistic-concurrency token for items. */
    itemsRevision: number | null;
}

/**
 * Take a fresh claim under the canonical money locks.
 *
 * The lock order is the documented one (tx-retry.ts): Estimate → Invoice → Client.
 * The Client is taken FOR SHARE — this only READS the mapping — but it must not
 * straddle the FOR UPDATE remap in `resolveCustomerAndItem`, which may have run
 * moments ago on this very request. Re-reading `qbCustomerId` inside the lock is
 * what makes "the customer this payload bills" a fact rather than a guess.
 *
 * The CAS the caller supplies pins the payload snapshot as well as the link and
 * the marker, so an edit landing between the handler's read and this write loses
 * rather than being silently sent to QuickBooks.
 */
async function claimDocumentSync(args: {
    estimateId?: string;
    invoiceId?: string;
    clientId: string;
    payload: DocumentPayloadIdentity;
    tokens: QBTokens;
    claimedAt: Date;
    claim: (tx: Prisma.TransactionClient, marker: string) => Promise<{ count: number }>;
}): Promise<{ ok: true; marker: string } | { ok: false; reason: string }> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        await lockMoneyParents(
            tx,
            { estimateId: args.estimateId ?? null, invoiceId: args.invoiceId ?? null, clientId: args.clientId },
            { clientLock: "share" },
        );
        const client = await tx.client.findUnique({
            where: { id: args.clientId },
            select: { qbCustomerId: true },
        });
        if (client?.qbCustomerId !== args.payload.customerId) {
            return {
                ok: false as const,
                reason: "its QuickBooks customer changed while this was being prepared",
            };
        }
        const marker = composeSyncMarker(
            CREATE_IN_FLIGHT_MARKER,
            {
                docNumber: args.payload.docNumber,
                privateNote: args.payload.privateNote,
                issuanceHash: args.payload.hash,
                expectedTotal: args.payload.total,
                realmId: args.tokens.realmId,
                customerId: args.payload.customerId,
            },
            args.claimedAt,
        );
        const claimed = await args.claim(tx, marker);
        if (claimed.count !== 1) {
            return { ok: false as const, reason: "another sync claimed it first, or it changed while being prepared" };
        }
        return { ok: true as const, marker };
    }));
}

type RecoveryOutcome =
    | { kind: "adopted"; response: NextResponse }
    | { kind: "create"; marker: string }
    | { kind: "refused"; response: NextResponse };

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
    marker: string;
    tokens: QBTokens;
    deadline: RouteDeadline;
    /** Adopt: persist the id and clear the marker in ONE compare-and-set. */
    adopt: (qbId: string) => Promise<{ count: number }>;
    /** Re-claim: put the marker back to create-in-flight, same nonce. */
    reclaim: (next: string) => Promise<{ count: number }>;
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
        const adopted = await args.adopt(probe.qbId);
        if (adopted.count !== 1) {
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
    const next = composeSyncMarker(CREATE_IN_FLIGHT_MARKER, identity, args.claimedAt);
    const reclaimed = await args.reclaim(next);
    if (reclaimed.count !== 1) {
        return { kind: "refused", response: retryLater(args.code, "it was being updated concurrently") };
    }
    return { kind: "create", marker: next };
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
            const estimateNote = documentPrivateNote(estimate.code, estimate.title);
            const estimatePayload: DocumentPayloadIdentity = {
                hash: documentIssuanceHash({
                    kind: "estimate",
                    code: estimate.code,
                    itemsRevision: estimate.itemsRevision,
                    total: estimate.totalAmount,
                    taxAmount: null,
                    title: estimate.title,
                    projectName: estimate.project?.name ?? null,
                    customerId,
                    lines: estimate.items.map((i) => ({
                        id: i.id, name: i.name, quantity: i.quantity,
                        unitCost: i.unitCost, total: i.total,
                    })),
                }),
                docNumber: estimate.code.slice(0, QB_DOC_NUMBER_MAX_LEN),
                privateNote: estimateNote,
                total: toNum(estimate.totalAmount),
                customerId,
                itemsRevision: estimate.itemsRevision,
            };
            let estimateMarker: string;
            let estimateClaimedAt = new Date();
            if (syncMarkerKind(estimate.qbSyncMarker)) {
                const stored = estimate.qbSyncMarker as string;
                estimateClaimedAt = new Date(parseCreateMarker(stored)?.atMs ?? Date.now());
                const recovery = await recoverClaimedRecord({
                    kind: "estimate", id: estimate.id, code: estimate.code,
                    marker: stored, tokens, deadline, claimedAt: estimateClaimedAt,
                    adopt: (qbId) => prisma.estimate.updateMany({
                        where: { id: estimate.id, qbEstimateId: null, qbSyncMarker: stored },
                        data: { qbEstimateId: qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
                    }),
                    reclaim: (next) => prisma.estimate.updateMany({
                        where: { id: estimate.id, qbEstimateId: null, qbSyncMarker: stored },
                        data: { qbSyncMarker: next },
                    }),
                    urlFor: estimateUrl,
                });
                if (recovery.kind !== "create") return recovery.response;
                estimateMarker = recovery.marker;
            } else {
                //    Claimed UNDER the money locks (Estimate → Invoice → Client), with
                //    the customer re-read inside them. `resolveCustomerAndItem` may
                //    have REMAPPED Client.qbCustomerId moments ago, and the payload
                //    identity has to describe the mapping that actually stands — not
                //    one read before a write that was still in flight.
                const claimed = await claimDocumentSync({
                    estimateId: estimate.id,
                    clientId: client.id,
                    payload: estimatePayload,
                    tokens,
                    claimedAt: estimateClaimedAt,
                    claim: (tx, marker) => tx.estimate.updateMany({
                        where: {
                            id: estimate.id,
                            qbEstimateId: null,
                            qbSyncMarker: null,
                            // The payload snapshot this claim describes. Pinned so a
                            // concurrent edit between the read at the top of this
                            // handler and the claim loses instead of being sent.
                            itemsRevision: estimate.itemsRevision,
                            totalAmount: estimate.totalAmount,
                            title: estimate.title,
                        },
                        data: { qbSyncMarker: marker },
                    }),
                });
                if (!claimed.ok) return retryLater(estimate.code, claimed.reason);
                estimateMarker = claimed.marker;
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
                customerId,
                itemId,
                project: estimate.project ? { name: estimate.project.name } : null,
                // The canonical marker note, not the bare title: this is what a
                // recovery matches on to prove the document is ours.
                privateNote: estimateNote,
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
            //    Pinned to the PAYLOAD as well as the marker. `itemsRevision` is
            //    the canonical optimistic-concurrency token for estimate items
            //    (#327) and moves on ANY item write, so an edit that landed while
            //    the create was in flight loses this CAS and the document is not
            //    linked — it is left for the recovery path, which will find it by
            //    the claim identity and refuse to adopt it against a changed row.
            const estimatePersisted = await prisma.estimate.updateMany({
                where: {
                    id: estimate.id,
                    qbSyncMarker: estimateMarker,
                    itemsRevision: estimate.itemsRevision,
                    totalAmount: estimate.totalAmount,
                    title: estimate.title,
                },
                data: { qbEstimateId: result.qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
            });
            if (estimatePersisted.count !== 1) {
                // The document EXISTS in QuickBooks and this record no longer
                // carries our claim, so it cannot be reported as a clean
                // success. Say what was created and where; the next sync
                // recovers it by DocNumber rather than making a second.
                return NextResponse.json(
                    {
                        error:
                            `QuickBooks created ${estimate.code} (id ${result.qbId}), but this estimate changed while ` +
                            `that was in flight, so the link was not recorded. Refresh and sync again.`,
                        retry: true,
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
        // note the estimate rail does.
        const invoiceNote = documentPrivateNote(invoice.code, invoice.project?.name ?? null);
        const invoicePayload: DocumentPayloadIdentity = {
            hash: documentIssuanceHash({
                kind: "invoice",
                code: invoice.code,
                itemsRevision: null,
                total: invoice.totalAmount,
                taxAmount: invoice.taxAmount,
                title: null,
                projectName: invoice.project?.name ?? null,
                customerId,
                lines: [],
            }),
            docNumber: invoice.code.slice(0, QB_DOC_NUMBER_MAX_LEN),
            privateNote: invoiceNote,
            total: toNum(invoice.totalAmount),
            customerId,
            itemsRevision: null,
        };
        let invoiceMarker: string;
        let invoiceClaimedAt = new Date();
        if (syncMarkerKind(invoice.qbSyncMarker)) {
            const stored = invoice.qbSyncMarker as string;
            invoiceClaimedAt = new Date(parseCreateMarker(stored)?.atMs ?? Date.now());
            const recovery = await recoverClaimedRecord({
                kind: "invoice", id: invoice.id, code: invoice.code,
                marker: stored, tokens, deadline, claimedAt: invoiceClaimedAt,
                adopt: (qbId) => prisma.invoice.updateMany({
                    where: { id: invoice.id, qbInvoiceId: null, qbSyncMarker: stored },
                    data: { qbInvoiceId: qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
                }),
                reclaim: (next) => prisma.invoice.updateMany({
                    where: { id: invoice.id, qbInvoiceId: null, qbSyncMarker: stored },
                    data: { qbSyncMarker: next },
                }),
                urlFor: invoiceUrl,
            });
            if (recovery.kind !== "create") return recovery.response;
            invoiceMarker = recovery.marker;
        } else {
            const claimed = await claimDocumentSync({
                invoiceId: invoice.id,
                clientId: invoice.client.id,
                payload: invoicePayload,
                tokens,
                claimedAt: invoiceClaimedAt,
                claim: (tx, marker) => tx.invoice.updateMany({
                    where: {
                        id: invoice.id,
                        qbInvoiceId: null,
                        qbSyncMarker: null,
                        totalAmount: invoice.totalAmount,
                        balanceDue: invoice.balanceDue,
                        taxAmount: invoice.taxAmount,
                    },
                    data: { qbSyncMarker: marker },
                }),
            });
            if (!claimed.ok) return retryLater(invoice.code, claimed.reason);
            invoiceMarker = claimed.marker;
        }

        const result = await syncInvoiceToQB(tokens, {
            code: invoice.code,
            totalAmount: toNum(invoice.totalAmount),
            balanceDue: toNum(invoice.balanceDue),
            customerId,
            itemId,
            project: invoice.project ? { name: invoice.project.name } : null,
            privateNote: invoiceNote,
        }, deadline, syncRequestId(invoice.id, invoiceMarker))
            .catch(async (error) => {
                await settleSyncMarker(
                    (data) => prisma.invoice.updateMany({ where: { id: invoice.id, qbSyncMarker: invoiceMarker }, data }),
                    invoiceMarker,
                    error,
                );
                throw error;
            });

        // Pinned to the payload as well as the marker, same reasoning as the
        // estimate rail: an edit that landed while the create was in flight must
        // not link a document describing the old numbers.
        const invoicePersisted = await prisma.invoice.updateMany({
            where: {
                id: invoice.id,
                qbSyncMarker: invoiceMarker,
                totalAmount: invoice.totalAmount,
                balanceDue: invoice.balanceDue,
                taxAmount: invoice.taxAmount,
            },
            data: { qbInvoiceId: result.qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
        });
        if (invoicePersisted.count !== 1) {
            return NextResponse.json(
                {
                    error:
                        `QuickBooks created ${invoice.code} (id ${result.qbId}), but this invoice changed while ` +
                        `that was in flight, so the link was not recorded. Refresh and sync again.`,
                    retry: true,
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
