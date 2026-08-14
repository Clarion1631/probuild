import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { derivedMarginPct } from "@/lib/budget-math";
import { isTaxCostCode, numOr, numOrNull, rmc, splitTakeoffTax } from "@/lib/takeoff-costing";
import { parseSalesTaxes } from "@/lib/sales-tax";

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
 *  2. Convert the stated markup: margin = markup / (100 + markup) x 100.
 *  3. Fall back to the default margin (also covers legacy rows saved before costing was carried).
 */
function marginPercentFor(item: any, baseCost: number | null, unitCost: number): number {
    if (baseCost != null && baseCost > 0 && unitCost > 0) {
        return derivedMarginPct(baseCost, unitCost);
    }
    const markup = numOrNull(item.markupPercent);
    if (markup != null && markup > -100) {
        return (markup / (100 + markup)) * 100;
    }
    return DEFAULT_MARGIN_PCT;
}

// POST /api/takeoffs/convert-to-estimate
// Converts AI-generated takeoff data into a real Estimate with line items
export async function POST(req: NextRequest) {
    const body = await req.json();
    const { takeoffId } = body;

    if (!takeoffId) {
        return NextResponse.json({ error: "takeoffId is required" }, { status: 400 });
    }

    const takeoff = await prisma.takeoff.findUnique({
        where: { id: takeoffId },
        include: { files: true },
    });

    if (!takeoff) {
        return NextResponse.json({ error: "Takeoff not found" }, { status: 404 });
    }

    if (!takeoff.aiEstimateData) {
        return NextResponse.json({ error: "No AI estimate data to convert. Generate an AI estimate first." }, { status: 400 });
    }

    // Parse the AI estimate data
    let aiData: any;
    try {
        aiData = JSON.parse(takeoff.aiEstimateData);
    } catch {
        return NextResponse.json({ error: "Invalid AI estimate data" }, { status: 400 });
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
        const companySettings = await prisma.companySettings.findUnique({
            where: { id: "singleton" },
            select: { salesTaxes: true },
        });
        // parseSalesTaxes swallows unparseable/non-array stored values (JSON.parse("null") and
        // JSON.parse("{}") both succeed without being an array, and the .filter below would throw
        // and fail the whole conversion).
        const salesTaxes = parseSalesTaxes(companySettings?.salesTaxes);
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

    const code = `EST-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        // Create the Estimate
        const estimate = await prisma.estimate.create({
            data: {
                title: `${takeoff.name} — AI Estimate`,
                projectId: takeoff.projectId || null,
                leadId: takeoff.leadId || null,
                code,
                status: "Draft",
                totalAmount: finalTotal,
                balanceDue: finalTotal,
                privacy: "Shared",
                ...(storedTaxRate != null ? { taxRatePercent: storedTaxRate, taxRateName } : {}),
            },
        });

        // Create all estimate line items
        for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx];
            // Tax is a pass-through: never let the default margin land on a tax line. Takeoffs
            // generated before the AI mapping carried markupPercent have no value stored at all,
            // so this guard also repairs those.
            const isTaxItem = isTaxCostCode(item.costCode);

            const baseCost = numOrNull(item.baseCost);
            const unitCost = numOr(item.unitCost, 0);
            const quantity = numOr(item.quantity, 1);

            await prisma.estimateItem.create({
                data: {
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
                },
            });
        }

        // Create payment schedules. `milestones` came from `aiData.paymentMilestones`, computed
        // upstream against `aiData.totalEstimate` — but the estimate above was stored with
        // `finalTotal`, which differs from `totalEstimate` whenever the tax split applied. Trusting
        // the stored `m.amount` in that case can leave the schedule not summing to the estimate
        // total, so recompute from `finalTotal` and the milestone PERCENTAGES instead. When the
        // split bailed out, `finalTotal === totalEstimate` and the milestones already match it, so
        // keep reading the stored amounts as-is (legacy behavior, unchanged).
        const recomputedMilestones = split.taxRatePercent != null ? recomputeMilestoneAmounts(finalTotal, milestones) : null;
        for (let idx = 0; idx < milestones.length; idx++) {
            const m = milestones[idx];
            const recomputed = recomputedMilestones ? recomputedMilestones[idx] : null;
            await prisma.estimatePaymentSchedule.create({
                data: {
                    estimateId: estimate.id,
                    name: m.name || `Payment ${idx + 1}`,
                    percentage: recomputed ? recomputed.percentage : parseFloat(m.percentage) || 0,
                    amount: recomputed ? recomputed.amount : parseFloat(m.amount) || 0,
                    dueDate: null,
                    order: idx,
                },
            });
        }

        // Link the takeoff to the new estimate
        await prisma.takeoff.update({
            where: { id: takeoffId },
            data: {
                estimateId: estimate.id,
                status: "Completed",
            },
        });

        // Build the redirect URL
        const redirectUrl = takeoff.projectId
            ? `/projects/${takeoff.projectId}/estimates/${estimate.id}`
            : `/leads/${takeoff.leadId}/estimates/${estimate.id}`;

        return NextResponse.json({
            estimateId: estimate.id,
            code: estimate.code,
            totalAmount: finalTotal,
            itemCount: items.length,
            redirectUrl,
        });
    } catch (err: any) {
        console.error("Convert to Estimate error:", err);
        return NextResponse.json({ error: err.message || "Failed to create estimate" }, { status: 500 });
    }
}
