import { NextRequest, NextResponse } from "next/server";
import { getQBSettings } from "@/lib/integration-store";
import {
    syncEstimateToQB, syncInvoiceToQB,
    createRouteDeadline, isQBBudgetExhaustedError, isQBTimeoutError, isQboConnectionFailure,
    isQBAmbiguousDocumentCreateError,
} from "@/lib/quickbooks";
import { getFreshQBTokens, resolveCustomerAndItem } from "@/lib/quickbooks-payments";
import { randomUUID } from "node:crypto";
import {
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    markerKind,
} from "@/lib/qbo-create-markers";
import { prisma } from "@/lib/prisma";
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
const MARKER_NONCE_SEP = ":";

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
 *     claim is promoted to `ambiguous-create`, KEEPING the same nonce so a
 *     later resolution can still reason about the requestid that was sent,
 *     and every further sync refuses until a human has looked.
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
    try {
        await write({
            qbSyncMarker: ambiguous
                ? composeSyncMarker(AMBIGUOUS_CREATE_MARKER, nonceOf(marker))
                : null,
        });
    } catch {
        // Best effort. A lost RELEASE leaves the record refusing further syncs
        // until a human clears it, which is the safe direction; a lost
        // PROMOTION leaves the in-flight marker, which also refuses.
    }
}

/** `create-in-flight:<nonce>` — the nonce is what makes the requestid stable. */
function composeSyncMarker(kind: string, nonce: string): string {
    return `${kind}${MARKER_NONCE_SEP}${nonce}`;
}

function nonceOf(marker: string): string {
    const at = marker.indexOf(MARKER_NONCE_SEP);
    return at === -1 ? "" : marker.slice(at + 1);
}

/**
 * The QuickBooks idempotency key for one create attempt.
 *
 * Keyed off the RECORD and the marker nonce, not off a fresh random value: a
 * replay has to send the identical key for Intuit to recognise it, and the
 * nonce is the only thing that survives a process death.
 */
function syncRequestId(recordId: string, marker: string): string {
    return `${recordId}:${nonceOf(marker)}`;
}

/** Already parked by an earlier attempt whose outcome nobody knows. */
function parkedResponse(code: string) {
    return NextResponse.json(
        {
            error:
                `A previous QuickBooks sync for ${code} ended without a confirmed result, so it may already exist there. ` +
                `Check QuickBooks: if the document was created, record its id; if not, clear the marker and sync again.`,
            retry: false,
            reason: "ambiguous-create",
        },
        { status: 409 },
    );
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
                    qbEstimateId: true, qbSyncMarker: true,
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
            // Parked by an attempt whose outcome is unknown. Fail closed: a
            // human has to look in QuickBooks before anything else is sent.
            if (markerKind(estimate.qbSyncMarker)) return parkedResponse(estimate.code);

            const client = estimate.project?.client;
            if (!client) return NextResponse.json({ error: "No client attached to estimate" }, { status: 400 });

            const qb = await getQBSettings();
            if (!qb.connected) {
                return NextResponse.json({ error: "QuickBooks not connected", notConnected: true }, { status: 400 });
            }
            const tokens = await getFreshQBTokens(deadline);

            const { customerId, itemId } = await resolveCustomerAndItem(tokens, client.id, deadline);

            // 2. CLAIM before the POST. Pinned to "still unlinked, still
            //    unclaimed", so a concurrent sync loses instead of racing this
            //    one into two documents. Failing to WRITE it aborts — an
            //    unwritten marker is exactly the invisible-crash case it guards.
            const estimateMarker = composeSyncMarker(CREATE_IN_FLIGHT_MARKER, randomUUID());
            const estimateClaim = await prisma.estimate.updateMany({
                where: { id: estimate.id, qbEstimateId: null, qbSyncMarker: null },
                data: { qbSyncMarker: estimateMarker },
            });
            if (estimateClaim.count !== 1) return parkedResponse(estimate.code);

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
            await prisma.estimate.updateMany({
                where: { id: estimate.id, qbSyncMarker: estimateMarker },
                data: { qbEstimateId: result.qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
            });

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
        if (markerKind(invoice.qbSyncMarker)) return parkedResponse(invoice.code);

        const qb = await getQBSettings();
        if (!qb.connected) {
            return NextResponse.json({ error: "QuickBooks not connected", notConnected: true }, { status: 400 });
        }
        const tokens = await getFreshQBTokens(deadline);

        const { customerId, itemId } = await resolveCustomerAndItem(tokens, invoice.client.id, deadline);

        const invoiceMarker = composeSyncMarker(CREATE_IN_FLIGHT_MARKER, randomUUID());
        const invoiceClaim = await prisma.invoice.updateMany({
            where: { id: invoice.id, qbInvoiceId: null, qbSyncMarker: null },
            data: { qbSyncMarker: invoiceMarker },
        });
        if (invoiceClaim.count !== 1) return parkedResponse(invoice.code);

        const result = await syncInvoiceToQB(tokens, {
            code: invoice.code,
            totalAmount: toNum(invoice.totalAmount),
            balanceDue: toNum(invoice.balanceDue),
            customerId,
            itemId,
            project: invoice.project ? { name: invoice.project.name } : null,
        }, deadline, syncRequestId(invoice.id, invoiceMarker))
            .catch(async (error) => {
                await settleSyncMarker(
                    (data) => prisma.invoice.updateMany({ where: { id: invoice.id, qbSyncMarker: invoiceMarker }, data }),
                    invoiceMarker,
                    error,
                );
                throw error;
            });

        await prisma.invoice.updateMany({
            where: { id: invoice.id, qbSyncMarker: invoiceMarker },
            data: { qbInvoiceId: result.qbId, qbSyncedAt: new Date(), qbSyncMarker: null },
        });

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
