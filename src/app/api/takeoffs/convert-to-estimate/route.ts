import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { derivedMarginPct } from "@/lib/budget-math";
import { isTaxCostCode, isTaxRow, numOr, numOrNull, rmc } from "@/lib/takeoff-costing";

/** The margin stored when a takeoff row carries no usable costing at all. */
const DEFAULT_MARGIN_PCT = 25;

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

    const rawItems = aiData.items || [];
    const milestones = aiData.paymentMilestones || [];
    const totalEstimate = aiData.totalEstimate || rawItems.reduce((s: number, i: any) => s + (i.total || 0), 0);

    // The AI quote carries sales tax as a visible "99-TAX" line item, but the Estimate model
    // speaks rate-based tax: totalAmount is tax-INCLUSIVE once taxRatePercent is set, and a
    // null rate means "no rate chosen yet" — the portal then displays default tax on top and
    // approval grosses the stored total up once (ensureProjectAndDepositInvoiceForEstimate).
    // Persisting the tax line as an item with a null rate therefore taxes the client twice.
    // Translate at this boundary, like the markup→margin conversion above: drop the tax
    // line(s) from the items and store the equivalent rate instead. The rate is derived from
    // the quoted amounts (not the AI's claimed percentage) so the stored total is preserved
    // to the cent: subtotal × (1 + r/100) === subtotal + taxAmount === totalEstimate, which
    // also keeps the AI's milestone amounts tying out against the total.
    const taxLines = rawItems.filter((i: any) => isTaxRow(i));
    const taxAmount = rmc(taxLines.reduce((s: number, i: any) => s + numOr(i.total, 0), 0));
    const subtotal = rmc(totalEstimate - taxAmount);
    // Degenerate quotes (tax with no taxable base, or tax exceeding the total) keep the old
    // shape: tax stays a visible line item and the rate stays null.
    const canonicalizeTax = taxAmount > 0 && subtotal > 0;
    const taxRatePercent = canonicalizeTax ? (taxAmount / subtotal) * 100 : null;
    const items = canonicalizeTax ? rawItems.filter((i: any) => !isTaxRow(i)) : rawItems;

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
                totalAmount: totalEstimate,
                balanceDue: totalEstimate,
                ...(canonicalizeTax
                    ? {
                          taxRatePercent,
                          taxRateName: String(taxLines[0]?.name || "Sales Tax").slice(0, 80),
                      }
                    : {}),
                privacy: "Shared",
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

        // Create payment schedules
        for (let idx = 0; idx < milestones.length; idx++) {
            const m = milestones[idx];
            await prisma.estimatePaymentSchedule.create({
                data: {
                    estimateId: estimate.id,
                    name: m.name || `Payment ${idx + 1}`,
                    percentage: parseFloat(m.percentage) || 0,
                    amount: parseFloat(m.amount) || 0,
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
            totalAmount: totalEstimate,
            itemCount: items.length,
            redirectUrl,
        });
    } catch (err: any) {
        console.error("Convert to Estimate error:", err);
        return NextResponse.json({ error: err.message || "Failed to create estimate" }, { status: 500 });
    }
}
