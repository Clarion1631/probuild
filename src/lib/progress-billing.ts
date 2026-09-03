/**
 * Progress billing core.
 *
 * Product model: estimate/invoice milestones (PaymentSchedule/EstimatePaymentSchedule)
 * are SUGGESTIONS. The billable artifact is a "progress billing" (ProgressBilling):
 * the user picks milestones and/or a custom amount, writes one client-facing
 * description, confirms tax, and stages exactly ONE QuickBooks invoice.
 * Milestones remain the record of truth for what has been satisfied, so a
 * billing that covers only PART of a milestone AUTO-SPLITS that milestone —
 * every billing line ends up mapped 1:1 to a whole milestone.
 *
 * Change orders are NOT a line type here. `billChangeOrderCore`
 * (src/lib/billing-core.ts) already bills an approved change order by adding
 * it to the invoice as a normal PaymentSchedule milestone (called from
 * `handleChangeOrderApproved` on approval) — it arrives here like any other
 * milestone line. A `changeOrderId` field on a progress-billing line would be
 * a second rail for the same money, so `createProgressBillingCore` rejects
 * any line that supplies one.
 *
 * Session-free cores (no auth checks) — actions.ts wrappers come in the UI pass,
 * same convention as billing-core.ts.
 *
 * HARD CONSTRAINTS carried through this whole file (owner-stated, non-negotiable):
 *   - No customer data loss: every write here is additive (new rows) or shrinks
 *     an existing PaymentSchedule/EstimatePaymentSchedule's `amount` — a split
 *     NEVER deletes or merges a milestone row.
 *   - No customer notifications: nothing in this file calls sendNotification /
 *     notifyMilestonePaid / drainPaymentNotifications / any send path. Staging
 *     to QuickBooks does not send a QuickBooks-hosted email either (QBO invoices
 *     are created without relying on Intuit's own invoice-email flow).
 */
import { prisma } from "@/lib/prisma";
import { withTxRetry, lockMoneyParents } from "./tx-retry";
import { toNum } from "./prisma-helpers";
import type { Prisma, ProgressBilling, ProgressBillingLine } from "@prisma/client";
import { createRouteDeadline, remainingBudgetMs, QB_DOC_NUMBER_MAX_LEN, canonicalPrivateNote, type RouteDeadline, type QBTokens } from "./quickbooks";
import {
    compensateAndUnlink,
    compensationWindowMs,
    isAmbiguousCreateFailure,
    QBAmbiguousCreateError,
    MILESTONE_PUSH_ROUTE_BUDGET_MS,
    MILESTONE_CLEANUP_BUDGET_MS,
} from "./quickbooks-payments";
import {
    composeCreateMarker,
    isBlockedByAmbiguousCreate,
    isQboInvoiceLinkedOrPending,
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    PAYLINK_PENDING_MARKER,
    QBResolveRequiredError,
} from "./qbo-create-markers";
import { progressBillingIssuanceHash } from "./qbo-issuance";
import { logAutomationEvent } from "./automation-events";

// Cent-round helper shared by every money computation below. EPSILON nudges
// values like 1.005 (which float as 1.00499999999...) up to the cent they were
// meant to land on instead of truncating down.
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type ProgressBillingLineInput = {
    scheduleId?: string;
    description: string;
    amount: number;
};

export type CreateProgressBillingInput = {
    description: string;
    lines: ProgressBillingLineInput[];
    taxExempt?: boolean;
    /**
     * Optional: when supplied, the client pays exactly this (tax-inclusive)
     * amount. Cross-checked against what the lines say they add up to
     * (`expectedGross`, within 2 cents) — a mismatch almost always means the
     * lines were entered in the wrong units (pre-tax vs gross), not that the
     * user wants an arbitrary rescale, so it throws rather than silently
     * redistributing the difference.
     */
    grossTotal?: number;
};

export type ProgressBillingWithLines = ProgressBilling & { lines: ProgressBillingLine[] };

/**
 * Build one progress billing.
 *
 * UNITS. `lines[].amount` is always expressed in the milestone's OWN units,
 * which differ by vintage (`Estimate.taxInclusiveMilestones`, defaulting to
 * legacy/true when the invoice has no estimate):
 *   • legacy vintage: milestone amounts are GROSS (tax-inclusive) — the line
 *     amount is literally what the client is paying against that milestone.
 *   • new vintage: milestone amounts are PRE-TAX — tax rides on top.
 * This applies uniformly to milestone lines and custom lines (materialized
 * into a brand-new milestone in the same units).
 *
 * TWO AMOUNTS PER LINE, DELIBERATELY DIFFERENT:
 *   • the PERSISTED amount (ProgressBillingLine.amount) — always PRE-TAX,
 *     since it feeds the QuickBooks invoice's taxable line; and
 *   • the SPLIT amount — what gets carved out of the milestone (or, for a
 *     custom line, what the newly-materialized milestone is sized to),
 *     expressed in that milestone's own units.
 * On a legacy tax-inclusive job these differ by exactly the tax: a $25,000
 * check against a $39,998.25 tax-inclusive milestone leaves $14,998.25
 * behind, while the QuickBooks line reads $22,977.94 + $2,022.06 tax. On a
 * pre-tax job they are identical.
 */
export async function createProgressBillingCore(
    invoiceId: string,
    input: CreateProgressBillingInput,
): Promise<ProgressBillingWithLines> {
    const description = (input.description || "").trim();
    if (!description) throw new Error("A description is required");
    if (!input.lines?.length) throw new Error("At least one line is required");

    const rawAmounts = input.lines.map((l) => r2(Number(l.amount)));
    rawAmounts.forEach((amt, i) => {
        if (!Number.isFinite(amt) || amt <= 0) {
            throw new Error(`Line ${i + 1} ("${input.lines[i].description || "untitled"}"): amount must be greater than zero`);
        }
    });

    let grossTotal: number | undefined;
    if (input.grossTotal !== undefined && input.grossTotal !== null) {
        grossTotal = r2(Number(input.grossTotal));
        if (!Number.isFinite(grossTotal) || grossTotal <= 0) {
            throw new Error("grossTotal must be greater than zero");
        }
    }

    const seenScheduleIds = new Set<string>();
    for (const line of input.lines) {
        // Change orders are billed by approving them (billChangeOrderCore adds
        // a milestone to the invoice on approval) — see this file's top
        // docstring. A changeOrderId here would be a second rail for the same
        // money, so it's rejected outright rather than silently accepted.
        if ((line as { changeOrderId?: unknown }).changeOrderId) {
            throw new Error("Change orders are billed by approving them, which adds a milestone to the invoice — bill that milestone here.");
        }
        if (line.scheduleId) {
            if (seenScheduleIds.has(line.scheduleId)) {
                throw new Error("The same milestone was referenced by more than one line");
            }
            seenScheduleIds.add(line.scheduleId);
        }
        if (!line.description || !line.description.trim()) {
            throw new Error("Every line needs a description");
        }
    }

    return withTxRetry(() => prisma.$transaction(async (tx) => {
        // Canonical lock order: Estimate → Invoice → schedules (tx-retry.ts).
        const invLink = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
        await lockMoneyParents(tx, { estimateId: invLink?.estimateId, invoiceId });

        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
        if (!invoice) throw new Error("Invoice not found");

        // Vintage: which units milestone amounts (and therefore every line in
        // this billing) are expressed in. No estimate (ad-hoc invoice) →
        // legacy/tax-inclusive, matching how every pre-existing invoice in the
        // system was priced.
        const estimateForUnits = invLink?.estimateId
            ? await tx.estimate.findUnique({ where: { id: invLink.estimateId }, select: { taxInclusiveMilestones: true } })
            : null;
        const legacy = estimateForUnits?.taxInclusiveMilestones ?? true;

        // Resolve + validate every line under the lock (no writes yet).
        const scheduleCache = new Map<string, NonNullable<Awaited<ReturnType<typeof prisma.paymentSchedule.findUnique>>>>();

        for (let i = 0; i < input.lines.length; i++) {
            const line = input.lines[i];

            if (line.scheduleId) {
                const schedule = await tx.paymentSchedule.findUnique({ where: { id: line.scheduleId } });
                if (!schedule || schedule.invoiceId !== invoiceId) {
                    throw new Error(`Milestone not found on this invoice: ${line.scheduleId}`);
                }
                if (schedule.status !== "Pending") {
                    throw new Error(`"${schedule.name}" is not Pending — only pending milestones can be billed`);
                }
                if (schedule.qbInvoiceId) {
                    throw new Error(`"${schedule.name}" already has a QuickBooks invoice staged — break the QuickBooks link first, then bill it here.`);
                }
                // A parked milestone has qbInvoiceId === null and may STILL have a
                // real invoice in QuickBooks. Billing it into a progress invoice
                // would leave the client holding two collectible invoices for the
                // same money — the exact failure the marker exists to prevent.
                if (isQboInvoiceLinkedOrPending(schedule)) {
                    throw new QBResolveRequiredError(schedule.name);
                }
                if (schedule.stripeSessionId || schedule.stripePaymentIntentId) {
                    throw new Error(`A payment is in progress on "${schedule.name}" — wait for it to finish or void it before billing.`);
                }
                // Over-billing (including double-billing an already-committed
                // milestone) is checked AFTER the tax math, in the consumption
                // guard below.
                scheduleCache.set(line.scheduleId, schedule);
            }
        }

        // ── Tax math ────────────────────────────────────────────────────────
        const taxExempt = !!input.taxExempt;
        const effectiveRate = taxExempt ? 0 : toNum(invoice.taxRate);

        const rawSum = r2(rawAmounts.reduce((s, a) => s + a, 0));
        const expectedGross = legacy ? rawSum : r2(rawSum * (1 + effectiveRate / 100));

        if (grossTotal !== undefined && Math.abs(grossTotal - expectedGross) > 0.02) {
            throw new Error(
                `The selected amounts total $${expectedGross.toFixed(2)} but the invoice total says $${grossTotal.toFixed(2)} — they must match.`
            );
        }

        const total = grossTotal ?? expectedGross;
        const subtotal = taxExempt ? total : r2(total / (1 + effectiveRate / 100));
        const taxAmount = taxExempt ? 0 : r2(total - subtotal);

        if (Math.abs(r2(subtotal + taxAmount) - total) > 0.005) {
            throw new Error("Internal error: subtotal + tax does not equal total");
        }

        // Persisted amounts (ProgressBillingLine.amount) are ALWAYS pre-tax:
        // each line's proportional share of subtotal, weighted by the raw
        // line amounts, with the rounding remainder landing on the LAST line.
        const finalAmounts = rawAmounts.map((a) => r2((a * subtotal) / rawSum));
        const usedSum = r2(finalAmounts.slice(0, -1).reduce((s, a) => s + a, 0));
        finalAmounts[finalAmounts.length - 1] = r2(subtotal - usedSum);
        finalAmounts.forEach((amt, i) => {
            if (amt <= 0) {
                throw new Error(
                    `Line ${i + 1} ("${input.lines[i].description || "untitled"}"): rescaled amount is $0.00 or less — adjust the line amounts or the total.`
                );
            }
        });
        const finalSum = r2(finalAmounts.reduce((s, a) => s + a, 0));
        if (Math.abs(finalSum - subtotal) > 0.005) {
            throw new Error("Internal error: line amounts do not sum to the subtotal");
        }

        // ── Split units ─────────────────────────────────────────────────────
        // What gets carved out of a milestone (or sizes a newly-materialized
        // one), in that milestone's own units:
        //   • legacy (tax-inclusive): the line's proportional share of TOTAL
        //     (gross) — a $25,000 check against Mesplay's $39,998.25 leaves
        //     $14,998.25 behind.
        //   • new vintage (pre-tax): identical to the persisted amount —
        //     finalAmounts already IS the milestone's own units.
        // Getting this wrong silently mis-splits live milestones by exactly
        // the tax, which is why every downstream check (consumption guard,
        // AUTO-SPLIT, custom-line materialization) uses splitAmounts rather
        // than the caller's raw input.
        let splitAmounts: number[];
        if (legacy) {
            splitAmounts = rawAmounts.map((a) => r2((a * total) / rawSum));
            const usedSplitSum = r2(splitAmounts.slice(0, -1).reduce((s, a) => s + a, 0));
            splitAmounts[splitAmounts.length - 1] = r2(total - usedSplitSum);
        } else {
            splitAmounts = finalAmounts.slice();
        }
        const splitCheckTarget = legacy ? total : subtotal;
        const splitSum = r2(splitAmounts.reduce((s, a) => s + a, 0));
        if (Math.abs(splitSum - splitCheckTarget) > 0.005) {
            throw new Error("Internal error: split amounts do not sum to the expected total");
        }

        // ── Consumption guard ──────────────────────────────────────────────
        // A milestone can only ever be claimed for its full amount, across
        // EVERY non-Void progress billing that has referenced it — not just
        // within this one call. Without this: a milestone billed in FULL
        // never triggers AUTO-SPLIT (its PaymentSchedule.amount never
        // changes), and a milestone's post-split ORIGINAL row keeps whatever
        // amount was billed into it — both stay "Pending" and can be billed
        // again for up to that same amount, silently double-billing the
        // client.
        for (let i = 0; i < input.lines.length; i++) {
            const line = input.lines[i];
            if (line.scheduleId) {
                const schedule = scheduleCache.get(line.scheduleId)!;
                // A sourceScheduleId pointing at a row that no longer exists means
                // the estimate mirror is already inconsistent. Refuse up front —
                // for ANY bill, full or partial. A partial would split
                // invoice-side only; a full one settles later and its
                // settle-time mirror silently no-ops, leaving the estimate
                // showing the milestone still owed. (sourceScheduleId is not an
                // FK, so this state is reachable.)
                if (schedule.sourceScheduleId) {
                    const mirror = await tx.estimatePaymentSchedule.findUnique({
                        where: { id: schedule.sourceScheduleId },
                        select: { id: true },
                    });
                    if (!mirror) {
                        throw new Error(
                            `"${schedule.name}" points at an estimate milestone that no longer exists — fix the estimate's payment schedule before billing this.`
                        );
                    }
                }

                const otherLines = await tx.progressBillingLine.findMany({
                    where: { scheduleId: line.scheduleId, billing: { status: { not: "Void" } } },
                    select: { splitAmount: true, billing: { select: { code: true } } },
                });
                // Sum the RECORDED split amounts. Reconstructing them from the
                // pre-tax `amount` re-applies tax to an already-rounded number and
                // can come out a cent low, which let a second billing claim that
                // cent on a milestone that was already fully billed.
                const committed = r2(otherLines.reduce((sum, l) => sum + toNum(l.splitAmount), 0));
                const available = r2(toNum(schedule.amount) - committed);
                if (splitAmounts[i] > available + 0.005) {
                    const codes = [...new Set(otherLines.map((l) => l.billing.code))].join(", ");
                    throw new Error(
                        `"${schedule.name}": billed amount $${splitAmounts[i].toFixed(2)} exceeds what's left — $${committed.toFixed(2)} of $${toNum(schedule.amount).toFixed(2)} is already billed${codes ? ` on ${codes}` : ""}.`
                    );
                }
            }
        }

        // ── AUTO-SPLIT ──────────────────────────────────────────────────────
        // Carves the billed portion out of the milestone using splitAmounts (the
        // milestone's own units — see above). Never deletes a PaymentSchedule /
        // EstimatePaymentSchedule row: the original is reduced in place and a NEW
        // row absorbs the remainder, so the two always sum to what was there
        // before and the invoice's totalAmount/balanceDue are untouched. Every
        // update is a conditional claim pinned to the exact amount read at the
        // top of this transaction, so a concurrent write (e.g. the legacy
        // pushMilestoneToQuickBooks linking a QBO invoice) between validation
        // and this write can't be silently overwritten.
        const resolvedScheduleIds = new Map<number, string>(); // line index -> PaymentSchedule.id billed (whole, post-split)
        for (let i = 0; i < input.lines.length; i++) {
            const line = input.lines[i];
            if (!line.scheduleId) continue;
            const schedule = scheduleCache.get(line.scheduleId)!;
            const splitAmount = splitAmounts[i];
            const scheduleAmount = toNum(schedule.amount);
            resolvedScheduleIds.set(i, schedule.id);

            // Full only when it covers the milestone exactly or more — never via a
            // half-cent tolerance, which would let a stored 100.004 be "fully"
            // billed at 100.00 and silently drop the remainder when the amount is
            // written back.
            const isFullBill = splitAmount >= scheduleAmount;
            const remainder = isFullBill ? 0 : r2(scheduleAmount - splitAmount);

            // Claim runs on EVERY bill, full or partial — not just splits. A full
            // bill writes the amount back unchanged, but the pinned WHERE is what
            // proves the row is still Pending, unlinked and untouched since
            // validation. Skipping it on full bills left a window where the legacy
            // pushMilestoneToQuickBooks could link its own QBO invoice to this same
            // milestone concurrently, leaving TWO collectible invoices for one
            // milestone (Codex round-2 blocker).
            const claim = await tx.paymentSchedule.updateMany({
                where: {
                    id: schedule.id,
                    status: "Pending",
                    qbInvoiceId: null,
                    // The id being null is not enough: a create that started
                    // between validation and here leaves the id null and the
                    // marker set, and that row may already be billed in QBO.
                    // Pinning the EXACT value read under the lock covers that
                    // without a NULL-unsafe NOT IN, and now that markers carry a
                    // per-issuance identity suffix there is no fixed list to
                    // match against anyway.
                    qbSyncError: schedule.qbSyncError,
                    stripeSessionId: null,
                    stripePaymentIntentId: null,
                    amount: schedule.amount,
                },
                // A full bill writes the amount back UNCHANGED — the point of the
                // claim there is the pinned WHERE, not the value.
                data: { amount: isFullBill ? schedule.amount : splitAmount },
            });
            if (claim.count !== 1) {
                throw new Error(`"${schedule.name}" changed while this billing was being built — refresh and try again.`);
            }

            if (isFullBill) continue; // claimed above; nothing to carve

            let newSourceScheduleId: string | null = null;
            if (schedule.sourceScheduleId) {
                const originalEst = await tx.estimatePaymentSchedule.findUnique({ where: { id: schedule.sourceScheduleId } });
                // Existence was already validated above (under the same lock and
                // transaction); this re-read is just to get the row's fields.
                if (!originalEst) {
                    throw new Error(
                        `"${schedule.name}" points at an estimate milestone that no longer exists — fix the estimate's payment schedule before billing this.`
                    );
                }
                {
                    const estClaim = await tx.estimatePaymentSchedule.updateMany({
                        where: {
                            id: originalEst.id,
                            status: "Pending",
                            stripeSessionId: null,
                            stripePaymentIntentId: null,
                            amount: originalEst.amount,
                        },
                        data: { amount: splitAmount },
                    });
                    if (estClaim.count !== 1) {
                        throw new Error(`"${originalEst.name}" changed while this billing was being built — refresh and try again.`);
                    }
                    const newEst = await tx.estimatePaymentSchedule.create({
                        data: {
                            estimateId: originalEst.estimateId,
                            name: `${originalEst.name} (remaining)`,
                            amount: remainder,
                            dueDate: originalEst.dueDate || null,
                            status: "Pending",
                            order: originalEst.order,
                            percentage: null,
                        },
                    });
                    newSourceScheduleId = newEst.id;
                }
            } else if (invLink?.estimateId) {
                // No estimate-side row to mirror even though this invoice HAS an
                // estimate: this PaymentSchedule has no sourceScheduleId, e.g. it
                // was materialized by an earlier progress billing's custom line
                // (see "materialize custom lines" below) or is a legacy ad-hoc
                // milestone that predates the mirror link. There is nothing on
                // the estimate side to split, so the split stays invoice-only.
                // Deliberate, not a bug — documented so the gap stays
                // reviewable rather than silently missed.
            }

            await tx.paymentSchedule.create({
                data: {
                    invoiceId,
                    name: `${schedule.name} (remaining)`,
                    amount: remainder,
                    status: "Pending",
                    dueDate: schedule.dueDate || null,
                    sourceScheduleId: newSourceScheduleId,
                },
            });
        }

        // ── Materialize custom lines as milestones ─────────────────────────
        // Every line must end up with a scheduleId. Milestone lines already
        // have one (resolvedScheduleIds, above); a custom amount (no
        // scheduleId — change-order lines are rejected up front, see above)
        // gets a brand-new Pending PaymentSchedule here, sized to its split
        // amount (milestone units). Unlike a milestone split, this GROWS the
        // invoice total — the money wasn't already part of the contract until
        // now — mirroring addInvoiceMilestone's status ladder exactly. This is
        // what lets a custom line settle through the normal milestone rail
        // with no special case.
        let materializedTotal = 0;
        for (let i = 0; i < input.lines.length; i++) {
            if (resolvedScheduleIds.has(i)) continue; // milestone line, already resolved
            const line = input.lines[i];
            const amount = splitAmounts[i];
            const newSchedule = await tx.paymentSchedule.create({
                data: {
                    invoiceId,
                    name: line.description.trim(),
                    amount,
                    status: "Pending",
                    sourceScheduleId: null,
                },
            });
            resolvedScheduleIds.set(i, newSchedule.id);
            materializedTotal = r2(materializedTotal + amount);
        }

        if (materializedTotal > 0) {
            const nextStatus = invoice.status === "Paid" ? "Partially Paid" : invoice.status;
            await tx.invoice.update({
                where: { id: invoiceId },
                data: {
                    totalAmount: { increment: materializedTotal },
                    balanceDue: { increment: materializedTotal },
                    ...(nextStatus !== invoice.status ? { status: nextStatus } : {}),
                },
            });
        }

        // ── Persist the billing ────────────────────────────────────────────
        // Code numbering: parse existing codes for this invoice and take the
        // max numeric "-P<n>" suffix + 1, rather than a raw count — a count
        // reuses a code (and collides with QuickBooks' DocNumber) after a
        // non-last Draft billing is deleted.
        const existingBillings = await tx.progressBilling.findMany({ where: { invoiceId }, select: { code: true } });
        const maxSuffix = existingBillings.reduce((max, b) => {
            const m = /-P(\d+)$/.exec(b.code);
            const n = m ? parseInt(m[1], 10) : 0;
            return Number.isFinite(n) && n > max ? n : max;
        }, 0);
        const code = `${invoice.code}-P${maxSuffix + 1}`;

        const billing = await tx.progressBilling.create({
            data: {
                invoiceId,
                code,
                description,
                status: "Draft",
                subtotal,
                taxExempt,
                // Always the invoice's real rate, even when taxExempt is true —
                // taxExempt only zeroes the *computation* above. That way,
                // un-exempting this billing later (updateProgressBillingCore)
                // recomputes tax at the correct rate instead of forever at 0.
                taxRate: toNum(invoice.taxRate),
                taxAmount,
                total,
            },
        });

        await tx.progressBillingLine.createMany({
            data: input.lines.map((line, i) => ({
                billingId: billing.id,
                scheduleId: resolvedScheduleIds.get(i) ?? null,
                description: line.description.trim(),
                amount: finalAmounts[i],
                splitAmount: splitAmounts[i],
                order: i,
            })),
        });

        const withLines = await tx.progressBilling.findUnique({
            where: { id: billing.id },
            include: { lines: { orderBy: { order: "asc" } } },
        });
        return withLines!;
    }));
}

export type UpdateProgressBillingInput = {
    description?: string;
    taxExempt?: boolean;
};

/**
 * Draft-only edit: description and/or tax-exempt status. Line composition
 * (which milestones/custom amounts make up the billing) is intentionally NOT
 * re-editable here — re-running AUTO-SPLIT against a changed
 * line set is exactly the kind of ambiguous, high-risk money logic this pass
 * avoids (see PROGRESS_BILLING_REPORT.md). To change the lines, delete this
 * Draft (safe — any split it already applied stays applied, see
 * deleteProgressBillingCore below) and create a fresh one.
 *
 * Tax treatment is NOT editable here either, for the same reason: the milestone
 * amounts were carved at creation from a total that depends on it, and changing
 * one without the other desynchronizes what QuickBooks charges from what
 * settlement credits. Delete and rebuild the Draft instead.
 */
/**
 * The billing moved between the guard read and the write.
 *
 * Its own type so callers can answer 409 rather than 500: nothing is wrong,
 * two people (or a person and the stage path) simply touched one row at once,
 * and the caller should re-read and decide again.
 */
export class ProgressBillingChangedError extends Error {
    name = "ProgressBillingChangedError";
    /** Read by callers as an HTTP status. */
    readonly status = 409;
    constructor(code: string) {
        super(`${code} changed while you were editing it — refresh and try again.`);
    }
}

/** Name-based: the Node 20 tsx loader can hand a caller a second copy of this module. */
export function isProgressBillingChangedError(error: unknown): boolean {
    return error instanceof Error && error.name === "ProgressBillingChangedError";
}

export async function updateProgressBillingCore(
    billingId: string,
    input: UpdateProgressBillingInput,
): Promise<ProgressBillingWithLines> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        const link = await tx.progressBilling.findUnique({ where: { id: billingId }, select: { invoiceId: true } });
        if (!link) throw new Error("Progress billing not found");
        await lockMoneyParents(tx, { invoiceId: link.invoiceId });

        const billing = await tx.progressBilling.findUnique({ where: { id: billingId } });
        if (!billing) throw new Error("Progress billing not found");
        // A parked row LOOKS editable — Draft, no qbInvoiceId — but a real,
        // collectible QuickBooks invoice may exist for it. Editing it (even just
        // the description) while that is unresolved risks the row later linking
        // to an invoice whose content no longer matches what was actually billed.
        if (isBlockedByAmbiguousCreate(billing)) {
            throw new QBResolveRequiredError(billing.code);
        }
        if (billing.status !== "Draft" || billing.qbInvoiceId) {
            throw new Error(`This billing is "${billing.status}"${billing.qbInvoiceId ? " and has a QuickBooks invoice staged" : ""} — only Draft billings without a staged QuickBooks invoice can be edited`);
        }

        const description = input.description !== undefined ? input.description.trim() : billing.description;
        if (!description) throw new Error("A description is required");

        // Description only — no money field is editable here. Flipping taxExempt
        // used to recompute the billing's tax and total while leaving the milestone
        // amounts carved at creation untouched: a legacy exempt $500 billing became
        // $544 when un-exempted, so QuickBooks charged $544 while settlement only
        // ever credited the $500 milestone, quietly stranding $44 (Codex round-2
        // blocker). Changing tax treatment or amounts means deleting this Draft and
        // creating a fresh one, which re-derives the splits from scratch.
        if (input.taxExempt !== undefined && !!input.taxExempt !== billing.taxExempt) {
            throw new Error(
                "Tax treatment can't be changed on an existing draft — delete this draft and create a new one so the milestone amounts are recalculated."
            );
        }

        // CAS, not an update-by-id — the same shape deleteProgressBillingCore
        // uses, and for the same reason. The guards above ran against a read;
        // the stage path writes its `create-in-flight` claim with a bare
        // `updateMany` from OUTSIDE this transaction, so `lockMoneyParents`
        // does not serialise against it. A stage that lands its claim in the
        // window between the read and the write here would otherwise get an
        // unconditional edit anyway: the description changes while a create for
        // the OLD description may already be landing at QuickBooks, and the row
        // is then a candidate to adopt an invoice it no longer matches.
        //
        // Re-asserting all three predicates makes the edit lose that race
        // instead of winning it silently. (The issuance hash carries
        // `description` for the same reason — see qbo-issuance.ts — so even a
        // write that somehow got through could not be adopted by the resolver.)
        const edited = await tx.progressBilling.updateMany({
            where: { id: billingId, status: "Draft", qbInvoiceId: null, qbSyncError: null },
            data: { description },
        });
        if (edited.count !== 1) {
            throw new ProgressBillingChangedError(billing.code);
        }

        const withLines = await tx.progressBilling.findUnique({
            where: { id: billingId },
            include: { lines: { orderBy: { order: "asc" } } },
        });
        return withLines!;
    }));
}

/**
 * Delete a Draft billing. Removes the billing + its lines only (lines cascade
 * via the DB FK — see prisma/schema.prisma's ProgressBillingLine.billing
 * relation). Any PaymentSchedule/EstimatePaymentSchedule split this billing
 * already applied (see createProgressBillingCore's AUTO-SPLIT) is NOT undone
 * or merged back — the two milestone pieces it created stay as independent
 * Pending rows. This matches the hard constraint that a split, once applied,
 * only ever creates rows; it never deletes or merges them. Likewise, a
 * milestone this billing materialized from a custom line (and the invoice
 * total bump that came with it) is NOT undone either — deleting the Draft
 * just removes the billing record; the money it already added to the
 * contract stays.
 */
export async function deleteProgressBillingCore(
    billingId: string,
): Promise<{ success: true; invoiceId: string; projectId: string }> {
    return withTxRetry(() => prisma.$transaction(async (tx) => {
        const link = await tx.progressBilling.findUnique({
            where: { id: billingId },
            select: { invoiceId: true, invoice: { select: { projectId: true } } },
        });
        if (!link) throw new Error("Progress billing not found");
        await lockMoneyParents(tx, { invoiceId: link.invoiceId });

        const billing = await tx.progressBilling.findUnique({ where: { id: billingId } });
        if (!billing) throw new Error("Progress billing not found");
        // A parked row LOOKS deletable — Draft, no qbInvoiceId — but a real,
        // collectible QuickBooks invoice may exist for it. Deleting the draft
        // would abandon that invoice with nothing in ProBuild pointing at it.
        if (isBlockedByAmbiguousCreate(billing)) {
            throw new QBResolveRequiredError(billing.code);
        }
        if (billing.status !== "Draft" || billing.qbInvoiceId) {
            throw new Error(`This billing is "${billing.status}"${billing.qbInvoiceId ? " and has a QuickBooks invoice staged" : ""} — only Draft billings without a staged QuickBooks invoice can be deleted`);
        }

        // Re-assert the deletable state IN the delete itself, not just at the
        // read above. The stage path's in-flight claim (stageProgressBillingToQuickBooksCore)
        // writes its `qbSyncError` CAS with a bare `updateMany` outside this
        // transaction — `lockMoneyParents` above does not serialize against it.
        // A stage that lands its claim in the gap between the read and the
        // delete would otherwise get an unconditional delete-by-id anyway,
        // wiping the row (and its in-flight claim) out from under a create that
        // may already be landing at QuickBooks, leaving a real invoice with
        // nothing in ProBuild pointing at it. `deleteMany` with the same
        // predicates makes this a CAS: it deletes only if nothing changed.
        const deleted = await tx.progressBilling.deleteMany({
            where: { id: billingId, status: "Draft", qbInvoiceId: null, qbSyncError: null },
        }); // cascades to ProgressBillingLine only
        if (deleted.count !== 1) {
            throw new Error("This billing changed while being deleted — refresh and try again.");
        }

        return { success: true as const, invoiceId: link.invoiceId, projectId: link.invoice.projectId };
    }));
}

/**
 * The PrivateNote every staged progress-billing invoice carries in QuickBooks.
 *
 * ONE definition, used by the stage path that writes it and by the ambiguous-
 * create resolver that has to recognise our invoice among whatever else shares
 * a DocNumber. Two copies of this string would let the resolver quietly stop
 * matching the invoices we actually create.
 */
export function progressBillingPrivateNote(invoiceCode: string, billingCode: string): string {
    return `ProBuild ${invoiceCode} · ${billingCode}`;
}

/**
 * The QBO calls staging makes. Injectable so a test can drive the REAL function
 * (the in-flight claim, the pre-pay-link link write, the compensation window)
 * against a fake QuickBooks instead of re-implementing those decisions.
 */
export interface ProgressBillingStageQbo {
    getTokens(deadline: RouteDeadline): Promise<QBTokens>;
    resolveCustomerAndItem(tokens: QBTokens, clientId: string, deadline: RouteDeadline): Promise<{ customerId: string; itemId: string }>;
    createInvoice(
        tokens: QBTokens,
        input: {
            docNumber: string;
            customerId: string;
            itemId: string;
            description: string;
            amount: number;
            tax: { preTaxAmount: number; taxAmount: number } | null;
            billEmail: string | null;
            privateNote: string;
        },
        deadline: RouteDeadline,
    ): Promise<{ qbId: string; total: number }>;
    getPaymentLink(tokens: QBTokens, qbInvoiceId: string, deadline: RouteDeadline): Promise<string | null>;
    deleteInvoice(tokens: QBTokens, qbInvoiceId: string, deadline: RouteDeadline): Promise<boolean>;
}

/** The ProgressBilling reads/writes staging makes; the test seam's other half. */
export interface ProgressBillingStageDb {
    findUnique(args: any): Promise<any>;
    updateMany(args: any): Promise<{ count: number }>;
}

/** What the final link decision settled on. */
export type ProgressBillingLinkVerdict =
    /** The link is written; the billing is Staged. */
    | { outcome: "linked" }
    /** The CAS lost: the row moved (or somebody else linked it first). */
    | { outcome: "lost" }
    /**
     * The money state this invoice was ISSUED from no longer describes the
     * billing — the client was repointed at another QuickBooks customer, or a
     * field the hash covers moved. Compensates, like `lost`, but says so.
     */
    | { outcome: "mismatch"; detail: string };

export interface ProgressBillingLinkArgs {
    billingId: string;
    invoiceId: string;
    clientId: string;
    qbId: string;
    inFlightMarker: string;
    /** The hash the marker carries — recomputed under the locks and compared. */
    issuanceHash: string;
    /** The content snapshot the QuickBooks invoice was created from. */
    /** Money as Prisma hands it back, so it can be pinned in a WHERE unchanged. */
    pinned: {
        subtotal: Prisma.Decimal | number;
        total: Prisma.Decimal | number;
        taxAmount: Prisma.Decimal | number;
        description: string;
    };
}

export interface ProgressBillingStageDeps {
    db?: ProgressBillingStageDb;
    qbo?: ProgressBillingStageQbo;
    logEvent?: typeof logAutomationEvent;
    /**
     * The final link decision. The default takes the money locks
     * (Estimate → Invoice → Client), re-reads the customer mapping under them,
     * refuses on any issuance divergence, and only then runs the CAS.
     *
     * Injectable so the in-memory stage tests can drive the SAME decision
     * against a fake table; when a test supplies `db` and not this, the
     * fallback runs the identical revalidation through that fake, so the two
     * differ only in whether real row locks are taken.
     */
    finalizeLink?: (args: ProgressBillingLinkArgs) => Promise<ProgressBillingLinkVerdict>;
}

/**
 * The issuance hash of a billing AS IT STANDS NOW.
 *
 * One definition, used by both finalizers below, so the locked path and the
 * in-memory path cannot disagree about what "unchanged" means.
 */
function currentBillingIssuanceHash(row: {
    status?: string | null;
    subtotal: unknown;
    total: unknown;
    taxAmount: unknown;
    description?: string | null;
    qbCustomerId: string | null;
}): string {
    return progressBillingIssuanceHash({
        // The literal the CAS itself requires — same reasoning as the identity
        // above: this asks whether the PAYLOAD state moved, not whether the
        // status did (the CAS answers that, and answers it first).
        status: "Draft",
        subtotal: row.subtotal,
        total: row.total,
        taxAmount: row.taxAmount,
        description: row.description ?? null,
        customerId: row.qbCustomerId,
    });
}

/**
 * The real link decision: money locks, re-read, issuance guard, CAS — all in ONE
 * transaction, so nothing can commit between the check and the write.
 *
 * The write used to be a bare `updateMany` outside any transaction. It pinned
 * the billing's own columns, which is enough to catch an edit to THIS row, and
 * nothing else: the QuickBooks customer lives on Client and is not pinned by
 * anything, so a client repointed at another customer between the create and
 * the link left every predicate matching while the invoice sitting in
 * QuickBooks billed somebody else.
 */
export async function finalizeProgressBillingLinkUnderLock(args: ProgressBillingLinkArgs): Promise<ProgressBillingLinkVerdict> {
    return withTxRetry(() => prisma.$transaction(async (tx): Promise<ProgressBillingLinkVerdict> => {
        // Estimate → Invoice → Client (tx-retry.ts). FOR SHARE on the Client:
        // this only reads the mapping, but it must not straddle the FOR UPDATE
        // remap in resolveCustomerAndItem.
        await lockMoneyParents(tx, { invoiceId: args.invoiceId, clientId: args.clientId }, { clientLock: "share" });
        const current = await tx.progressBilling.findUnique({
            where: { id: args.billingId },
            select: {
                status: true, subtotal: true, total: true, taxAmount: true, description: true,
                invoice: { select: { client: { select: { qbCustomerId: true } } } },
            },
        });
        if (!current) return { outcome: "mismatch", detail: "the billing no longer exists" };
        const hashNow = currentBillingIssuanceHash({
            ...current,
            qbCustomerId: current.invoice?.client?.qbCustomerId ?? null,
        });
        if (hashNow !== args.issuanceHash) {
            return {
                outcome: "mismatch",
                detail: "the QuickBooks customer or the amounts behind it changed while it was being created",
            };
        }
        const claimed = await tx.progressBilling.updateMany({
            where: progressBillingLinkWhere(args),
            // PAYLINK_PENDING_MARKER, not null: the pay-link fetch is still to
            // come, and if it fails this marker is the only thing that tells
            // sweepPendingPayLinks there is a linked row left to finish.
            data: { status: "Staged", qbInvoiceId: args.qbId, qbSyncedAt: new Date(), qbSyncError: PAYLINK_PENDING_MARKER },
        });
        return claimed.count === 1 ? { outcome: "linked" } : { outcome: "lost" };
    }));
}

/**
 * The same decision against an injected table. No row locks (there is no
 * database), but the identical re-read, guard and CAS — so the in-memory tests
 * exercise the real rule rather than a simplified stand-in.
 */
function finalizeProgressBillingLinkWithDb(db: ProgressBillingStageDb) {
    return async (args: ProgressBillingLinkArgs): Promise<ProgressBillingLinkVerdict> => {
        const current = await db.findUnique({ where: { id: args.billingId } });
        if (!current) return { outcome: "mismatch", detail: "the billing no longer exists" };
        const hashNow = currentBillingIssuanceHash({
            ...current,
            qbCustomerId: current.invoice?.client?.qbCustomerId ?? null,
        });
        if (hashNow !== args.issuanceHash) {
            return {
                outcome: "mismatch",
                detail: "the QuickBooks customer or the amounts behind it changed while it was being created",
            };
        }
        const claimed = await db.updateMany({
            where: progressBillingLinkWhere(args),
            // PAYLINK_PENDING_MARKER, not null: the pay-link fetch is still to
            // come, and if it fails this marker is the only thing that tells
            // sweepPendingPayLinks there is a linked row left to finish.
            data: { status: "Staged", qbInvoiceId: args.qbId, qbSyncedAt: new Date(), qbSyncError: PAYLINK_PENDING_MARKER },
        });
        return claimed.count === 1 ? { outcome: "linked" } : { outcome: "lost" };
    };
}

/**
 * The CAS predicate, in one place so both finalizers pin the same thing.
 *
 * `taxAmount` is here alongside subtotal and total: the payload tax line is
 * `{ preTaxAmount: subtotal, taxAmount }`, so a tax-only change re-issues a
 * different invoice while leaving subtotal and total untouched — it was the one
 * money column the pin had been missing.
 */
function progressBillingLinkWhere(args: ProgressBillingLinkArgs) {
    return {
        id: args.billingId,
        status: "Draft",
        qbInvoiceId: null,
        // Prove we still own the claim before writing the link — without this, a
        // row whose marker moved on for an unrelated reason (compensated,
        // resolved by an admin, reclaimed by a retry) but still happened to read
        // Draft/unlinked/unchanged could get THIS invoice attached to it.
        qbSyncError: args.inFlightMarker,
        subtotal: args.pinned.subtotal,
        total: args.pinned.total,
        taxAmount: args.pinned.taxAmount,
        description: args.pinned.description,
    };
}

async function defaultStageQbo(): Promise<ProgressBillingStageQbo> {
    const { getFreshQBTokens, resolveCustomerAndItem } = await import("./quickbooks-payments");
    const { createQBMilestoneInvoice, getQBInvoicePaymentLink, deleteQBInvoice } = await import("./quickbooks");
    return {
        getTokens: (deadline) => getFreshQBTokens(deadline),
        resolveCustomerAndItem: (tokens, clientId, deadline) => resolveCustomerAndItem(tokens, clientId, deadline),
        createInvoice: async (tokens, input, deadline) => {
            const created = await createQBMilestoneInvoice(tokens, input, deadline);
            return { qbId: created.qbId, total: created.total };
        },
        getPaymentLink: (tokens, qbInvoiceId, deadline) => getQBInvoicePaymentLink(tokens, qbInvoiceId, deadline),
        deleteInvoice: (tokens, qbInvoiceId, deadline) => deleteQBInvoice(tokens, qbInvoiceId, deadline),
    };
}

/**
 * Stage a Draft billing's ONE QuickBooks invoice. Never sends any email —
 * deliberately: this pass ships no customer notifications (owner's hard
 * constraint; see PROGRESS_BILLING_REPORT.md). A later UI pass wires an
 * explicit "send" action on top of this, same split as the milestone rail
 * (pushMilestoneToQuickBooks stages; sendMilestoneInvoicesCore sends).
 *
 * Duplicate-bill safety, identical to the milestone rail:
 *   1. The row is CAS-claimed `qbSyncError: null -> create-in-flight` BEFORE the
 *      POST goes out. Losing that CAS refuses the stage; failing to WRITE it
 *      aborts, because an unwritten marker is exactly the invisible-crash case
 *      it guards.
 *   2. A definitive refusal (4xx) releases the claim — QuickBooks created
 *      nothing. An unknown outcome promotes it to `ambiguous-create` and the
 *      next stage refuses until a human resolves it.
 *   3. The returned QBO id is persisted BEFORE the pay-link fetch, so a timeout
 *      on that second remote call can never abandon a real invoice. The row is
 *      left `paylink-pending` for the maintenance sweep to finish.
 *
 * Compensation: bounded, and only in the window where the row is NOT yet
 * linked. Once the link write lands, deleting the QBO invoice would strand a
 * linked row pointing at nothing, so the pay-link stage never compensates.
 */
export async function stageProgressBillingToQuickBooksCore(
    billingId: string,
    deadline?: RouteDeadline,
    deps?: ProgressBillingStageDeps,
): Promise<{ success: true; qbInvoiceId: string; qbInvoiceLink: string | null }> {
    const db: ProgressBillingStageDb = deps?.db ?? prisma.progressBilling;
    const logEvent = deps?.logEvent ?? logAutomationEvent;
    // Locked-and-revalidated by default. A test that injects only `db` gets the
    // same rule against that fake table — not a bypass.
    const finalizeLink = deps?.finalizeLink
        ?? (deps?.db ? finalizeProgressBillingLinkWithDb(deps.db) : finalizeProgressBillingLinkUnderLock);
    const billing = await db.findUnique({
        where: { id: billingId },
        include: {
            invoice: {
                include: {
                    client: { select: { id: true, name: true, email: true, qbCustomerId: true } },
                },
            },
        },
    });
    if (!billing) throw new Error("Progress billing not found");
    if (billing.status !== "Draft") {
        throw new Error(`This billing is "${billing.status}" — only Draft billings can be staged to QuickBooks`);
    }
    if (billing.qbInvoiceId) {
        throw new Error("This billing already has a QuickBooks invoice staged");
    }

    const invoice = billing.invoice;
    const qbo = deps?.qbo ?? await defaultStageQbo();

    // Same split as the milestone push: `routeDeadline` is the platform
    // ceiling this stage — and its possible compensating delete — must fit
    // inside; `stageDeadline` (the work budget) carves MILESTONE_CLEANUP_BUDGET_MS
    // off its front, sharing the same start time, so that reserve is still
    // genuinely there when compensation begins instead of measured off the
    // (by then exhausted) work budget.
    const routeDeadline = deadline ?? createRouteDeadline(MILESTONE_PUSH_ROUTE_BUDGET_MS);
    const stageDeadline = createRouteDeadline(
        Math.max(1_000, routeDeadline.budgetMs - MILESTONE_CLEANUP_BUDGET_MS),
        routeDeadline.startedAt,
    );

    // Fail closed BEFORE spending a single QBO call: a previous attempt may
    // already have created this invoice, or another stager is mid-flight right
    // now. (ProgressBilling carries no updatedAt, so an in-flight marker has no
    // readable age — it blocks either way, and the resolver is how it clears.)
    if (isBlockedByAmbiguousCreate(billing)) {
        throw new QBAmbiguousCreateError(billing.code);
    }

    const tokens = await qbo.getTokens(stageDeadline);
    const { customerId, itemId } = await qbo.resolveCustomerAndItem(tokens, invoice.clientId, stageDeadline);

    const subtotal = toNum(billing.subtotal);
    const taxAmount = toNum(billing.taxAmount);
    const total = toNum(billing.total);

    // Claim the stage BEFORE the request goes out. Losing this CAS means another
    // stager got there first — refuse rather than race them into two invoices.
    // The write is deliberately NOT swallowed: without the marker a crash
    // between the POST and the link write is invisible, and the next stage
    // creates a second collectible invoice.
    //
    // The marker CARRIES the recovery identity (docNumber + PrivateNote) in the
    // same CAS, so a recovery never has to recompute it from state that may
    // have moved since — see composeCreateMarker.
    //
    // The ISSUANCE HASH rides along for the same reason as on the milestone
    // rail: the code and the note prove an invoice is ours, not that it still
    // describes this billing. A create that lands, loses the link CAS below
    // (the billing was edited or voided mid-stage) and then fails to compensate
    // leaves a real invoice for the old total with a perfectly matching
    // identity — the resolver must be able to see the row moved.
    // Truncated to QBO's PrivateNote cap BEFORE it goes anywhere — this exact
    // string is what createQBMilestoneInvoice will send (it truncates again,
    // harmlessly) and what the marker's identity records. Composing the
    // identity from the untruncated note would make it un-matchable: QBO
    // stores the truncated version, resolveAmbiguousInvoiceCreateCore compares
    // by exact equality, and a mismatch reads as "no invoice found" — which
    // lets a `confirmed-none` clear release a row that already has a real,
    // collectible duplicate sitting in QuickBooks.
    // canonicalPrivateNote, not a bare `.slice()`: it also collapses whitespace
    // runs and trims the ends, and it is the SAME function the create payload
    // applies. A raw slice here left the marker holding an untrimmed string
    // while QuickBooks stored the trimmed one, so a code carrying stray
    // whitespace made our own invoice invisible to the resolver.
    const privateNote = canonicalPrivateNote(progressBillingPrivateNote(invoice.code, billing.code));
    // Truncated to QBO's DocNumber cap BEFORE it goes anywhere — same reasoning
    // as the PrivateNote truncation above. `createInvoice` (createQBMilestoneInvoice)
    // truncates again defensively, but the marker's identity has to be composed
    // from the SAME value QBO actually stores, or the resolver's exact-match
    // lookup misses a document we did create.
    const docNumber = billing.code.slice(0, QB_DOC_NUMBER_MAX_LEN);
    const identity = {
        docNumber,
        privateNote,
        // Pinned to the values the link CAS below requires, not to whatever was
        // loaded — those are what this invoice is genuinely issued against.
        issuanceHash: progressBillingIssuanceHash({
            status: "Draft",
            subtotal: billing.subtotal,
            total: billing.total,
            // The payload's tax line is { preTaxAmount: subtotal, taxAmount },
            // so a tax-only edit re-issues a different invoice while leaving
            // subtotal and total alone — and the customer decides who is
            // billed at all. Both belong in the fingerprint.
            taxAmount: billing.taxAmount,
            // The one payload field a human can still move on a Draft
            // (updateProgressBillingCore edits nothing else), and it is what
            // the create sends as the QuickBooks line Description.
            description: billing.description,
            customerId,
        }),
        // The QBO invoice TOTAL this create expects to produce. DocNumber +
        // PrivateNote prove a resolved match is OURS; they carry no dollar
        // figure, so this is what lets the ambiguous-create resolver refuse a
        // coincidental match whose total is wrong instead of linking it blind.
        expectedTotal: total,
        // WHICH BOOK and WHICH CUSTOMER this POST is going to — same reasoning
        // as the milestone rail. Without the realm, a recovery run after a
        // reconnect to a different company queries the wrong books, finds
        // nothing, and offers to clear a row whose invoice is collectible.
        realmId: tokens.realmId,
        customerId,
    };
    // Captured once and reused for the promotion below — the ambiguous-create
    // marker must carry this SAME claim time, not a fresh one taken after the
    // request ends. See composeCreateMarker's `at` param.
    const claimedAt = new Date();
    const inFlightMarker = composeCreateMarker(CREATE_IN_FLIGHT_MARKER, identity, claimedAt);
    // Pinned to the same content snapshot the create is about to build the
    // invoice from — status alone lets a concurrent edit change subtotal,
    // total, tax, or description between the pre-claim read above and this
    // write and still pass the CAS, staging an invoice that no longer matches
    // the billing.
    const claimedSend = await db.updateMany({
        where: {
            id: billing.id,
            status: "Draft",
            qbInvoiceId: null,
            qbSyncError: null,
            subtotal: billing.subtotal,
            total: billing.total,
            taxAmount: billing.taxAmount,
            description: billing.description,
        },
        data: { qbSyncError: inFlightMarker },
    });
    if (claimedSend.count !== 1) {
        throw new QBAmbiguousCreateError(billing.code);
    }

    let created: { qbId: string; total: number };
    try {
        created = await qbo.createInvoice(tokens, {
            docNumber,
            customerId,
            itemId,
            description: billing.description,
            amount: total,
            tax: taxAmount > 0 ? { preTaxAmount: subtotal, taxAmount } : null,
            billEmail: invoice.client?.email || null,
            privateNote,
        }, stageDeadline);
    } catch (error) {
        if (!isAmbiguousCreateFailure(error)) {
            // QuickBooks answered "no" and created nothing, so this billing is
            // freely re-stageable: release the in-flight claim. Pinned to the
            // exact marker we wrote — releasing someone else's claim would
            // unblock a row whose outcome is genuinely unknown.
            await db.updateMany({
                where: { id: billing.id, qbSyncError: inFlightMarker },
                data: { qbSyncError: null },
            }).catch(() => {});
            throw error;
        }
        // Outcome unknown: the request may have created a real invoice. Promote
        // the in-flight claim to the durable marker so the next stage refuses
        // rather than double-billing.
        await db.updateMany({
            where: { id: billing.id, qbInvoiceId: null, qbSyncError: inFlightMarker },
            data: { qbSyncError: composeCreateMarker(AMBIGUOUS_CREATE_MARKER, identity, claimedAt) },
        });
        await logEvent({
            kind: "qbo-payments-sync",
            status: "error",
            reason: AMBIGUOUS_CREATE_MARKER,
            source: "progress-billing-stage",
            docNumber: billing.code,
            detail: { progressBillingId: billing.id, error: error instanceof Error ? error.name : "unknown" },
        });
        throw new QBAmbiguousCreateError(billing.code);
    }

    const qbId = created.qbId;

    // Compensate: never leave a created QBO invoice unreferenced and unmentioned.
    // Bounded exactly like the milestone push's compensation — measured when
    // compensation begins, capped by the route's real headroom. Only ever called
    // while the row is still UNLINKED.
    // Delete the invoice AND release any provisional link that landed for it.
    // The link write below can fail after committing (a dead response), so
    // "we never linked it" is not something this path can assume — the CAS
    // inside compensateAndUnlink is pinned to the exact id, so it clears the
    // row only when the row really does point at the invoice being deleted.
    // A progress billing also has to come back to Draft to be re-stageable.
    let compensationUnlinkFailed = false;
    const compensate = async (): Promise<boolean> => {
        // Measured off `routeDeadline`, not `stageDeadline` — the reserve was
        // carved out of the route's front on entry, so it is still really
        // there even once the work budget itself is exhausted.
        const cleanupDeadline = createRouteDeadline(compensationWindowMs(remainingBudgetMs(routeDeadline)));
        const { deleted, unlinked } = await compensateAndUnlink(
            db,
            billing.id,
            qbId,
            () => qbo.deleteInvoice(tokens, qbId, cleanupDeadline),
            { status: "Draft" },
            inFlightMarker,
        );
        compensationUnlinkFailed = deleted && !unlinked;
        return deleted;
    };
    const orphanError = (reason: string) =>
        new Error(
            `Staging this billing's QuickBooks invoice failed (${reason}), and the abandoned QuickBooks invoice ${billing.code} (id ${qbId}) could not be deleted — remove it in QuickBooks by hand, then retry.`
        );

    // A lost claim after a successful compensation still needs saying when the
    // row DID carry our link: the invoice is gone, but the row would keep
    // pointing at it and refuse the next stage. Declared before either
    // `compensate()` call site below so both can use it — the link-write catch
    // used to skip this and silently drop the "deleted but not unlinked" state
    // on the floor, re-throwing only the original write error.
    const compensationNote = () =>
        compensationUnlinkFailed
            ? ` The abandoned QuickBooks invoice ${billing.code} was deleted, but the link in ProBuild could not be cleared — clear it before re-staging.`
            : "";

    // Persist the link FIRST, before the pay-link fetch. That read is another
    // remote call, and a timeout there used to abandon a real, created invoice.
    // Guards pin id, Draft status, no existing qbInvoiceId, and the exact content
    // snapshot (subtotal/total/description) this QBO invoice was created from — a
    // mid-stage edit or concurrent stage can't silently attach to a row it no
    // longer describes.
    let claimedLink: ProgressBillingLinkVerdict;
    try {
        claimedLink = await finalizeLink({
            billingId: billing.id,
            invoiceId: billing.invoiceId,
            clientId: invoice.clientId,
            qbId,
            inFlightMarker,
            issuanceHash: identity.issuanceHash,
            pinned: {
                subtotal: billing.subtotal,
                total: billing.total,
                taxAmount: billing.taxAmount,
                description: billing.description,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // "The write failed" is NOT the same as "nothing points at the new
        // invoice". A commit whose response died, or a concurrent stage that
        // linked this same invoice first (both share one issuance key, so
        // Intuit hands them the same invoice), both land here with the row
        // ALREADY pointing at `qbId`. Compensating on that deletes a live,
        // correct QuickBooks invoice — the same failure the lost-CAS branch
        // below already guards against, which this path was missing.
        const current = await db.findUnique({
            where: { id: billing.id },
            select: { qbInvoiceId: true, qbInvoiceLink: true },
        }).catch(() => null);
        if (current?.qbInvoiceId === qbId) {
            return { success: true as const, qbInvoiceId: qbId, qbInvoiceLink: current.qbInvoiceLink ?? null };
        }
        if (!(await compensate())) throw orphanError(message);
        // Deleted, but check whether the local unlink ALSO landed —
        // `compensate()` sets `compensationUnlinkFailed` from
        // `compensateAndUnlink`'s `unlinked` field. Re-throwing the bare
        // original error here used to discard that: the QBO invoice would be
        // gone while the row kept its in-flight/link state, silently blocking
        // every future stage attempt with no indication why.
        throw new Error(`${message}${compensationNote()}`);
    }

    if (claimedLink.outcome !== "linked") {
        // A lost claim is most often a CONCURRENT stage that linked this very
        // invoice first (both share one issuance key, so Intuit returned the
        // same invoice to both). Compensating would delete the winner's invoice
        // out from under it.
        const current = await db.findUnique({
            where: { id: billing.id },
            select: { qbInvoiceId: true, qbInvoiceLink: true },
        }).catch(() => null);
        if (current?.qbInvoiceId === qbId) {
            return { success: true as const, qbInvoiceId: qbId, qbInvoiceLink: current.qbInvoiceLink ?? null };
        }
        // Say WHICH failure this was: "changed while staging" is misleading for
        // a billing that never moved and whose CUSTOMER did — the operator would
        // go looking at the billing and find nothing wrong with it.
        const whatChanged = claimedLink.outcome === "mismatch"
            ? `This billing could not be linked to its new QuickBooks invoice because ${claimedLink.detail}`
            : "This billing changed while staging its QuickBooks invoice";
        if (!(await compensate())) throw orphanError(whatChanged);
        throw new Error(`${whatChanged} — refresh and try again.${compensationNote()}`);
    }

    // From here the row IS linked. Never compensate past this point: deleting
    // the invoice would leave a Staged row pointing at nothing.
    let payLink: string | null;
    try {
        payLink = await qbo.getPaymentLink(tokens, qbId, stageDeadline);
    } catch (error) {
        if (!isAmbiguousCreateFailure(error)) throw error;
        // Linked but no pay link: PAYLINK_PENDING_MARKER stays for
        // sweepPendingPayLinks (src/lib/quickbooks-payments.ts, run by the
        // qbo-maintenance sync-payment-options action) to finish. The invoice
        // exists and is correct; only the convenience link is missing, so this is
        // a success, not something the operator must fix.
        console.warn(`[progress-billing] pay link pending for ${billing.code} (QBO id ${qbId})`);
        return { success: true as const, qbInvoiceId: qbId, qbInvoiceLink: null };
    }

    // Pinned to the id we just wrote, so a concurrent unlink/re-stage can't have
    // its link overwritten by ours.
    await db.updateMany({
        where: { id: billing.id, qbInvoiceId: qbId },
        data: { qbInvoiceLink: payLink, qbSyncError: null },
    });

    return { success: true as const, qbInvoiceId: qbId, qbInvoiceLink: payLink };
}
