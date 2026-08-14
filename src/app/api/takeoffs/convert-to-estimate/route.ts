import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { derivedMarginPct } from "@/lib/budget-math";
import { isTaxCostCode, numOr, numOrNull, rmc, splitTakeoffTax } from "@/lib/takeoff-costing";
import { parseSalesTaxes } from "@/lib/sales-tax";
import { withTxRetry } from "@/lib/tx-retry";

/** The margin stored when a takeoff row carries no usable costing at all. */
const DEFAULT_MARGIN_PCT = 25;

/**
 * Re-proportion a milestone split across a (possibly new) total. Percentages are normalized to
 * sum to exactly 100 (or split evenly if the source sums to <= 0), and the last milestone absorbs
 * the rounding residual so amounts always sum to `total` exactly. The stored percentage is
 * normalized too, so percentage and amount never disagree.
 *
 * Mirrors `recomputeMilestones` in `src/lib/gpt-estimate.ts` (same normalize / last-absorbs-residual
 * shape, `rmc` in place of that function's `toCents` — both are `Math.round(n * 100) / 100`). Kept
 * as a small local helper rather than an import so this route doesn't drag in gpt-estimate.ts's
 * unrelated dependencies.
 */
function recomputeMilestoneAmounts(
    total: number,
    source: Array<{ name?: string; percentage?: unknown }>,
): { name: string; percentage: number; amount: number }[] {
    if (source.length === 0) return [];
    let pcts = source.map((m) => numOr(m.percentage, 0));
    const pctSum = rmc(pcts.reduce((s, p) => s + p, 0));
    if (pctSum <= 0) {
        const eq = 100 / source.length;
        pcts = source.map(() => eq);
    } else if (Math.abs(pctSum - 100) > 0.01) {
        pcts = pcts.map((p) => (p * 100) / pctSum);
    }
    let pctAllocated = 0;
    let allocated = 0;
    return source.map((m, idx) => {
        const isLast = idx === source.length - 1;
        const percentage = isLast ? rmc(100 - pctAllocated) : rmc(pcts[idx]);
        pctAllocated = rmc(pctAllocated + percentage);
        const amount = isLast ? rmc(total - allocated) : rmc((percentage / 100) * total);
        allocated = rmc(allocated + amount);
        return { name: m.name || `Payment ${idx + 1}`, percentage, amount };
    });
}

/**
 * Translate a takeoff row's costing into the value `EstimateItem.markupPercent` actually holds.
 *
 * Despite the column name, the estimate side stores GROSS MARGIN — `sellFromMargin` inverts it as
 * `sell = cost / (1 - m/100)` (see the note in `lib/budget-math.ts`). The AI takeoff prompt speaks
 * true MARKUP instead (`sell = cost x (1 + m/100)`), so the model's "25" describes a 20% margin.
 * Writing it through unconverted would put a number on the line that disagrees with the line's own
 * cost and price, and every downstream margin read would inherit that.
 *
 * Preference order:
 *  1. Derive from the row's own cost and price — the pair is what the client was quoted, so the
 *     margin derived from it keeps the row internally consistent no matter what the model claimed.
 *  2. Credit rows: cost and price both negative derive the SAME way — dividing two negatives is
 *     positive, so the ratio (and the margin it implies) is unchanged by flipping both signs
 *     positive before calling derivedMarginPct, which only guards `price <= 0` as "no margin".
 *     Mirrors the identical sign-check `splitTakeoffTax` already applies to the tax row's own
 *     credit case (`src/lib/takeoff-costing.ts`).
 *  3. Convert the stated markup: margin = markup / (100 + markup) x 100.
 *  4. A cost/price pair present with MIXED signs (one negative, one not) is not a rate-based
 *     relationship — the ratio implies a number the row's own figures contradict (e.g. it can
 *     clamp to 99% while the numbers show the opposite). Rather than fabricate
 *     DEFAULT_MARGIN_PCT next to a pair it doesn't describe, such a row is stored at 0% margin —
 *     the same sentinel already written for pass-through tax rows, so downstream readers already
 *     treat 0 as a legitimate, non-default value.
 *  5. Fall back to the default margin — rows with no costing data at all (legacy rows saved
 *     before costing was carried).
 */
function marginPercentFor(item: any, baseCost: number | null, unitCost: number): number {
    if (baseCost != null && baseCost > 0 && unitCost > 0) {
        return derivedMarginPct(baseCost, unitCost);
    }
    if (baseCost != null && baseCost < 0 && unitCost < 0) {
        return derivedMarginPct(-baseCost, -unitCost);
    }
    const markup = numOrNull(item.markupPercent);
    if (markup != null && markup > -100) {
        return (markup / (100 + markup)) * 100;
    }
    if ((baseCost != null && baseCost < 0) || unitCost < 0) {
        return 0;
    }
    return DEFAULT_MARGIN_PCT;
}

/**
 * The conversion's derived values, computed from ONE consistent read of the takeoff row.
 *
 * Pure apart from the caller-supplied `salesTaxesJson`, so it is safe to run inside the
 * transaction — which is where it must run. Everything it derives (line items, milestone amounts,
 * the tax mode) comes from takeoff fields another request can change, so computing them from a
 * snapshot taken BEFORE the row lock would let a conversion write an estimate describing a takeoff
 * that no longer looks like that.
 */
type BuiltConversion = {
    items: any[];
    milestones: any[];
    finalTotal: number;
    taxRatePercent: number | null;
    taxRateName: string | null;
    recomputedMilestones: ReturnType<typeof recomputeMilestoneAmounts> | null;
};

async function buildConversion(
    aiEstimateData: string,
    // Lazy on purpose: the configured sales taxes are only ever consulted to NAME a derived rate,
    // so a conversion with unparseable AI data or no tax split must not spend a query (or inherit
    // that query's failure mode) fetching them.
    loadSalesTaxes: () => Promise<string | null>,
): Promise<{ error: string } | BuiltConversion> {
    let aiData: any;
    try {
        aiData = JSON.parse(aiEstimateData);
    } catch {
        return { error: "Invalid AI estimate data" };
    }

    // aiData.items can arrive as something other than an array (malformed/legacy AI output) — a
    // non-array would still reach the .reduce/.filter calls below and throw a 500 instead of
    // falling back cleanly.
    const rawItems: any[] = Array.isArray(aiData.items) ? aiData.items : [];
    const milestones = aiData.paymentMilestones || [];
    // numOr, not `i.total || 0`: a stringy total (`"1000"`) would otherwise string-concatenate
    // through `+` instead of summing (`"01000500"`), corrupting the legacy fallback total.
    const totalEstimate = aiData.totalEstimate || rawItems.reduce((s: number, i: any) => s + numOr(i.total, 0), 0);

    // Tax-mode invariant: the AI takeoff prompt writes sales tax as a `99-TAX` LINE ITEM, so
    // `totalEstimate` above is tax-INCLUSIVE with no `taxRatePercent` set. Every downstream
    // consumer (portal display, the approval gross-up in actions.ts) reads a null
    // `taxRatePercent` as "tax-EXCLUSIVE, gross up by the default rate at approval" — left as-is,
    // that grosses up an already-tax-inclusive total a second time. splitTakeoffTax() strips the
    // tax row(s) out of the items and derives the rate they imply, so the estimate created below
    // is stored in the app's canonical shape (pre-tax items + taxRatePercent) instead. When it
    // can't derive a trustworthy rate, it bails out and returns the items unchanged — legacy
    // (pre-existing) behavior for that case.
    const split = splitTakeoffTax(rawItems);
    const items = split.taxRatePercent != null ? split.items : rawItems;

    // The generating route now snapshots the rate and jurisdiction the takeoff was priced at, so the
    // rate does not have to be reconstructed from the tax row's dollars at all. Trust it only when
    // it RECONCILES with those dollars to the penny — a snapshot that disagrees with the line items
    // is not a description of this estimate, and the items are what the client was shown. Legacy
    // takeoffs carry no snapshot and fall through to the derivation below unchanged.
    const snapshot = aiData?.salesTax;
    const snapshotRate = typeof snapshot?.rate === "number" && Number.isFinite(snapshot.rate) ? snapshot.rate : null;
    const snapshotReconciles =
        snapshotRate != null &&
        snapshotRate >= 0 &&
        split.taxRatePercent != null &&
        rmc((split.preTaxSubtotal * snapshotRate) / 100) === split.taxAmount;
    const snapshotName =
        snapshotReconciles && typeof snapshot?.name === "string" && snapshot.name.trim() !== "" ? snapshot.name.trim() : null;

    let taxRateName: string | null = null;
    if (snapshotReconciles) {
        taxRateName = snapshotName ?? "Sales Tax";
    } else if (split.taxRatePercent != null) {
        // parseSalesTaxes swallows unparseable/non-array stored values (JSON.parse("null") and
        // JSON.parse("{}") both succeed without being an array, and the .filter below would throw
        // and fail the whole conversion).
        const salesTaxes = parseSalesTaxes(await loadSalesTaxes());
        // Two configured jurisdictions can share a rate, and the AI takeoff line's own name can
        // assert a jurisdiction the derived rate contradicts — either way, naming the wrong city on
        // a client-facing document is worse than a neutral label. Only trust a configured tax's
        // name when it is the SOLE match; never fall back to the AI line item's name at all.
        // Tolerance is tight (< 0.0001, not the old < 0.01): naming a jurisdiction on a
        // client-facing document requires the derived rate to actually BE that jurisdiction's
        // rate — a 0.01 window let a derived 8.409% match (and inherit the name of) a configured
        // 8.4% tax it isn't.
        const matches = salesTaxes.filter(
            (t) => typeof t?.rate === "number" && Number.isFinite(t.rate) && Math.abs(t.rate - split.taxRatePercent!) < 0.0001,
        );
        const soleMatch = matches.length === 1 ? matches[0] : null;
        taxRateName = soleMatch && typeof soleMatch.name === "string" && soleMatch.name.trim() !== "" ? soleMatch.name : "Sales Tax";
    }

    // When the snapshot reconciles it is the exact configured rate, so it is stored in preference to
    // the derived one: they agree to the penny on this estimate's dollars (that is what reconciling
    // means), but only the snapshot is the rate a later edit should reprice at.
    const storedTaxRate = snapshotReconciles ? snapshotRate : split.taxRatePercent;

    const finalTotal = storedTaxRate != null ? rmc(split.preTaxSubtotal + split.taxAmount) : totalEstimate;

    // Payment schedule amounts. `milestones` came from `aiData.paymentMilestones`, computed
    // upstream against `aiData.totalEstimate` — but the estimate is stored with `finalTotal`,
    // which differs from `totalEstimate` whenever the tax split applied. Trusting the stored
    // `m.amount` in that case can leave the schedule not summing to the estimate total, so
    // recompute from `finalTotal` and the milestone PERCENTAGES instead. When the split bailed
    // out, `finalTotal === totalEstimate` and the milestones already match it, so keep reading the
    // stored amounts as-is (legacy behavior, unchanged).
    const recomputedMilestones = split.taxRatePercent != null ? recomputeMilestoneAmounts(finalTotal, milestones) : null;

    // `storedTaxRate`, not the derived `split.taxRatePercent` — when the takeoff's snapshot
    // reconciles it is the exact configured rate, and that is the one a later edit must reprice at.
    return { items, milestones, finalTotal, taxRatePercent: storedTaxRate, taxRateName, recomputedMilestones };
}

// POST /api/takeoffs/convert-to-estimate
// Converts AI-generated takeoff data into a real Estimate with line items
export async function POST(req: NextRequest) {
    const body = await req.json();
    const { takeoffId } = body;

    if (!takeoffId) {
        return NextResponse.json({ error: "takeoffId is required" }, { status: 400 });
    }

    try {
        // ATOMICITY + IDEMPOTENCY. These writes (the Estimate, its line items, its payment
        // schedules, and the Takeoff link) used to run as four independent statements: a failure
        // partway through returned a 500 while leaving a complete, findable Estimate carrying real
        // money with no payment schedules and no takeoff link. They are one transaction now, so
        // the conversion either lands whole or leaves nothing behind.
        //
        // The transaction opens by locking the Takeoff row, and EVERYTHING it goes on to use — the
        // idempotency check, the takeoff's project/lead ownership, and the AI data the line items
        // and milestones are built from — is read under that lock. Reading any of it beforehand
        // would let a concurrent edit (a reassignment to another project, a re-run of the AI
        // estimate) land between the read and the write, producing an estimate that describes a
        // takeoff which no longer looks like that.
        //
        // The lock is also what makes a second conversion a no-op instead of a duplicate. Note
        // that `Takeoff.estimateId` being `@unique` does NOT provide this on its own: the unique
        // index only forbids two takeoffs pointing at one estimate — it happily allows one takeoff
        // to be REPOINTED at a second estimate, which is exactly the orphaning this prevents.
        const outcome = await withTxRetry(() =>
            prisma.$transaction(
                async (tx) => {
                    // The lock's own result is the existence check. `FOR UPDATE` locks NOTHING when
                    // the row is absent, so a read that followed an empty lock would be unlocked:
                    // under READ COMMITTED a row with this id could be inserted in between, and two
                    // requests could then each convert it. No row here means no row to convert.
                    const locked = await tx.$queryRaw<
                        { id: string }[]
                    >`SELECT id FROM "Takeoff" WHERE id = ${takeoffId} FOR UPDATE`;
                    if (locked.length === 0) return { kind: "error" as const, status: 404, message: "Takeoff not found" };

                    const takeoff = await tx.takeoff.findUnique({
                        where: { id: takeoffId },
                        // `files` was included by the previous read here and never used; loading it
                        // inside the transaction would only lengthen the lock hold.
                        select: { name: true, projectId: true, leadId: true, aiEstimateData: true, estimateId: true },
                    });
                    if (!takeoff) return { kind: "error" as const, status: 404, message: "Takeoff not found" };

                    const redirectTo = (id: string) =>
                        takeoff.projectId ? `/projects/${takeoff.projectId}/estimates/${id}` : `/leads/${takeoff.leadId}/estimates/${id}`;

                    if (takeoff.estimateId) {
                        const existing = await tx.estimate.findUnique({
                            where: { id: takeoff.estimateId },
                            select: {
                                id: true,
                                code: true,
                                totalAmount: true,
                                projectId: true,
                                leadId: true,
                                _count: { select: { items: true } },
                            },
                        });
                        // Already converted: hand back the estimate that already exists rather
                        // than minting a second one, matching how re-approval is handled in
                        // `ensureProjectAndDepositInvoiceForEstimate`.
                        if (existing) {
                            return {
                                kind: "existing" as const,
                                estimateId: existing.id,
                                code: existing.code,
                                // Decimal — send a plain number, never the Prisma Decimal object.
                                totalAmount: Number(existing.totalAmount),
                                itemCount: existing._count.items,
                                // Route by the ESTIMATE's own owner, not the takeoff's. A takeoff
                                // reassigned after it was converted no longer agrees with the
                                // estimate it already produced, and the estimate lives where its
                                // own projectId/leadId says it does.
                                redirectUrl: existing.projectId
                                    ? `/projects/${existing.projectId}/estimates/${existing.id}`
                                    : `/leads/${existing.leadId}/estimates/${existing.id}`,
                            };
                        }
                        // The link outlived its estimate. The FK nulls this column when an estimate
                        // is deleted, so reaching here means a money document went missing outside
                        // the app's own delete path — say so loudly. Failing the request would only
                        // strand the takeoff, so convert and repair the link.
                        console.error(
                            `Convert to Estimate: takeoff ${takeoffId} points at missing estimate ${takeoff.estimateId} — reconverting`,
                        );
                    }

                    if (!takeoff.aiEstimateData) {
                        return {
                            kind: "error" as const,
                            status: 400,
                            message: "No AI estimate data to convert. Generate an AI estimate first.",
                        };
                    }

                    const built = await buildConversion(takeoff.aiEstimateData, async () => {
                        const companySettings = await tx.companySettings.findUnique({
                            where: { id: "singleton" },
                            select: { salesTaxes: true },
                        });
                        return companySettings?.salesTaxes ?? null;
                    });
                    if ("error" in built) return { kind: "error" as const, status: 400, message: built.error };

                    const { items, milestones, finalTotal, taxRatePercent, taxRateName, recomputedMilestones } = built;
                    const code = `EST-${Math.floor(1000 + Math.random() * 9000)}`;

                    // Create the Estimate
                    const estimate = await tx.estimate.create({
                        data: {
                            title: `${takeoff.name} — AI Estimate`,
                            projectId: takeoff.projectId || null,
                            leadId: takeoff.leadId || null,
                            code,
                            status: "Draft",
                            totalAmount: finalTotal,
                            balanceDue: finalTotal,
                            privacy: "Shared",
                            ...(taxRatePercent != null ? { taxRatePercent, taxRateName } : {}),
                        },
                    });

                    // createMany, not a create-per-row: every round trip here is taken while
                    // holding the Takeoff lock and spending the transaction's time budget, so a
                    // large takeoff's line items must not scale the lock hold linearly.
                    if (items.length > 0) {
                        await tx.estimateItem.createMany({
                            data: items.map((item: any, idx: number) => {
                                // Tax is a pass-through: never let the default margin land on a tax
                                // line. Takeoffs generated before the AI mapping carried
                                // markupPercent have no value stored at all, so this guard also
                                // repairs those.
                                const isTaxItem = isTaxCostCode(item.costCode);

                                const baseCost = numOrNull(item.baseCost);
                                const unitCost = numOr(item.unitCost, 0);
                                const quantity = numOr(item.quantity, 1);

                                return {
                                    estimateId: estimate.id,
                                    name: item.name || "Unnamed Item",
                                    description: item.description || "",
                                    type: item.type || item.costType || "Material",
                                    quantity,
                                    baseCost,
                                    markupPercent: isTaxItem ? 0 : marginPercentFor(item, baseCost, unitCost),
                                    unitCost,
                                    total: numOr(item.total, 0),
                                    order: idx,
                                    parentId: null,
                                    costCodeId: item.costCodeId || null,
                                    costTypeId: item.costTypeId || null,
                                };
                            }),
                        });
                    }

                    if (milestones.length > 0) {
                        await tx.estimatePaymentSchedule.createMany({
                            data: milestones.map((m: any, idx: number) => {
                                const recomputed = recomputedMilestones ? recomputedMilestones[idx] : null;
                                return {
                                    estimateId: estimate.id,
                                    name: m.name || `Payment ${idx + 1}`,
                                    percentage: recomputed ? recomputed.percentage : parseFloat(m.percentage) || 0,
                                    amount: recomputed ? recomputed.amount : parseFloat(m.amount) || 0,
                                    dueDate: null,
                                    order: idx,
                                };
                            }),
                        });
                    }

                    // Link the takeoff to the new estimate
                    await tx.takeoff.update({
                        where: { id: takeoffId },
                        data: {
                            estimateId: estimate.id,
                            status: "Completed",
                        },
                    });

                    return {
                        kind: "created" as const,
                        estimateId: estimate.id,
                        code: estimate.code,
                        totalAmount: finalTotal,
                        itemCount: items.length,
                        redirectUrl: redirectTo(estimate.id),
                    };
                },
                // `timeout` is the budget for the WHOLE transaction — the wait on the `FOR UPDATE`
                // row lock behind a concurrent conversion, plus every statement after it. `maxWait`
                // is a different clock: it caps how long Prisma waits to check a pooled connection
                // OUT before the transaction begins, and does not cover the row-lock wait at all.
                // The work inside is bounded (bulk inserts, not per-row round trips), so the 30s is
                // headroom for lock contention rather than for the inserts themselves.
                { maxWait: 10_000, timeout: 30_000 },
            ),
        );

        if (outcome.kind === "error") {
            return NextResponse.json({ error: outcome.message }, { status: outcome.status });
        }

        return NextResponse.json({
            estimateId: outcome.estimateId,
            code: outcome.code,
            totalAmount: outcome.totalAmount,
            itemCount: outcome.itemCount,
            redirectUrl: outcome.redirectUrl,
            ...(outcome.kind === "existing" ? { alreadyConverted: true } : {}),
        });
    } catch (err: any) {
        console.error("Convert to Estimate error:", err);
        return NextResponse.json({ error: err.message || "Failed to create estimate" }, { status: 500 });
    }
}
