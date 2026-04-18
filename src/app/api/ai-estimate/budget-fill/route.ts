import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAnthropicText } from "@/lib/anthropic";
import Anthropic from "@anthropic-ai/sdk";

// Only unlocked items are sent — locked (PO-committed or user-set budget) items are
// held out on the client and passed as aggregate fixed contributions here.
type ItemInput = {
    id: string;
    name: string;
    description: string;
    type: string;
    quantity: number;  // SELL quantity — AI must not change; budget will mirror this
    unitCost: number;  // SELL price per unit — AI must not change
    lineTotal: number; // quantity × unitCost
};

type LockedContributions = {
    totalSellAmount: number;
    totalBudgetAmount: number;
};

type Suggestion = {
    id: string;
    budgetRate: number;
    budgetUnit: string;
    tradeCategory: string;
    reasoning: string;
};

export const maxDuration = 120;

export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const {
        items,
        lockedContributions,
        targetMarginPercent,
        projectContext,
        location,
    }: {
        items: ItemInput[];
        lockedContributions?: LockedContributions;
        targetMarginPercent?: number;
        projectContext?: string;
        location?: string;
    } = await req.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
        return NextResponse.json({ error: "items array is required" }, { status: 400 });
    }

    if (items.length > 150) {
        return NextResponse.json({ error: "Too many items (max 150 per request)" }, { status: 400 });
    }

    const target = Number.isFinite(targetMarginPercent) ? Math.max(0, Math.min(70, targetMarginPercent!)) : 25;
    const lockedSell = Number.isFinite(lockedContributions?.totalSellAmount) ? lockedContributions!.totalSellAmount : 0;
    const lockedBudget = Number.isFinite(lockedContributions?.totalBudgetAmount) ? lockedContributions!.totalBudgetAmount : 0;

    const aiSellTotal = items.reduce((s, i) => s + (Number.isFinite(i.lineTotal) ? i.lineTotal : (i.quantity || 0) * (i.unitCost || 0)), 0);
    const grandSellTotal = aiSellTotal + lockedSell;
    const targetBudgetTotal = grandSellTotal * (1 - target / 100);
    const neededFromAi = Math.max(0, targetBudgetTotal - lockedBudget);

    const itemsList = items.map((item, i) =>
        `${i + 1}. ID:"${item.id}" | ${item.name} | type=${item.type} | qty=${item.quantity} | sell=$${(item.unitCost || 0).toFixed(2)}/unit (line=$${(item.lineTotal || 0).toFixed(2)}) | desc="${item.description || ""}"`
    ).join("\n");

    const prompt = `You are an expert residential remodeling cost estimator in ${location || "Vancouver, WA"} (Pacific Northwest). Your job: choose an internal cost (budgetRate) for each line item so the WEIGHTED OVERALL MARGIN of the whole estimate lands on a target.

HARD CONSTRAINTS (do not violate):
- DO NOT suggest sell prices. The customer-facing price (unitCost × quantity) is FIXED.
- DO NOT change quantity. Budget quantity will mirror the sell quantity on the client.
- Your ONLY degree of freedom per item is budgetRate (cost per unit).
- Never suggest a budgetRate greater than or equal to the item's unitCost (that would be a negative margin).

PROJECT CONTEXT: ${projectContext || "Residential remodel"}

TARGET:
- Overall gross margin across the ENTIRE estimate = ${target}%.
- Locked items (already budgeted or PO-committed, not shown) already contribute:
    lockedSell    = $${lockedSell.toFixed(2)}
    lockedBudget  = $${lockedBudget.toFixed(2)}
- The items below (that you ARE filling) total sell = $${aiSellTotal.toFixed(2)}.
- Grand total sell = $${grandSellTotal.toFixed(2)}.
- Target total budget = grandSell × (1 - ${target}/100) = $${targetBudgetTotal.toFixed(2)}.
- Therefore sum(your budgetRate × quantity) should be ≈ $${neededFromAi.toFixed(2)}.

PER-ITEM MARGIN DISTRIBUTION (guidance, not a hard rule — final margins must still weight-average to ~${target}%):
- Commoditized trades (flooring, paint, drywall, demolition, batt insulation, basic landscape): 12-20% margin — labor-commodity; competitive pricing.
- Standard trades (framing, roofing, siding, tile, basic electrical/plumbing, HVAC, windows, concrete): 20-30% margin.
- Specialty / value-add (custom millwork, cabinets, countertops, design, project management, permitting, allowances): 30-40% margin — where contractor judgment and coordination show up.
- If the target is unusually low (<15%) or high (>40%), shift the bands proportionally but keep relative ordering.

MARKET RATE REFERENCE (${location || "Vancouver, WA"} 2024-2025) — sanity-check against these; do not exceed reasonable bounds:
- General labor: $45-65/hr | Skilled carpenter: $55-80/hr
- Electrician sub: $85-120/hr | Plumber sub: $90-130/hr | HVAC sub: $95-140/hr
- Drywall: $2.50-4/sq ft | Paint: $3.50-5.50/sq ft | Tile: $12-25/sq ft installed
- LVP flooring: $5-9/sq ft installed | Cabinets (mid): $250-450/lf
- Granite/quartz tops: $55-100/sq ft | Demolition: $1,500-4,000/room
- Permits: $500-3,000 | Lumber framing: $3-6/lf | Insulation batt: $1.50-3/sq ft
- Roofing: $4-8/sq ft | Concrete: $8-15/sq ft | Windows (mid): $400-900/ea installed

ITEMS TO FILL (${items.length}):
${itemsList}

OUTPUT — return ONLY valid JSON in this exact shape:
{
  "suggestions": [
    {
      "id": "<exact id from input>",
      "budgetRate": <number, cost per unit, less than unitCost>,
      "budgetUnit": "<ea|hr|sqft|lf|cy|sy|...>",
      "tradeCategory": "<flooring|paint|drywall|demolition|insulation|framing|roofing|siding|tile|electrical|plumbing|hvac|windows|concrete|millwork|cabinets|countertops|design|pm|permitting|allowance|other>",
      "reasoning": "<1 short sentence>"
    }
  ],
  "projectedMarginPercent": <your estimate of the weighted margin these suggestions produce, including locked contributions>,
  "notes": "<1 line: any caveat, e.g. 'Could not hit ${target}% exactly — lumber prices force lower margin on framing'. Empty string if nothing to report.>"
}`;

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 16000,
            messages: [{ role: "user", content: prompt }],
        });

        const rawText = getAnthropicText(response.content);
        if (!rawText) {
            return NextResponse.json({ error: "No response from AI" }, { status: 502 });
        }

        let parsed: any;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            // Model sometimes wraps JSON in ```json fences or prose — extract first {...} block.
            const objMatch = rawText.match(/\{[\s\S]*\}/);
            if (objMatch) {
                parsed = JSON.parse(objMatch[0]);
            } else {
                return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
            }
        }

        const suggestions: Suggestion[] = (parsed.suggestions || []).map((s: any) => ({
            id: String(s.id ?? ""),
            budgetRate: Math.max(0, parseFloat(s.budgetRate) || 0),
            budgetUnit: typeof s.budgetUnit === "string" && s.budgetUnit.length > 0 ? s.budgetUnit : "ea",
            tradeCategory: typeof s.tradeCategory === "string" ? s.tradeCategory : "other",
            reasoning: typeof s.reasoning === "string" ? s.reasoning : "",
        })).filter((s: Suggestion) => s.id);

        const projectedMarginPercent = Number.isFinite(parsed.projectedMarginPercent)
            ? parseFloat(parsed.projectedMarginPercent)
            : null;
        const notes = typeof parsed.notes === "string" ? parsed.notes : "";

        return NextResponse.json({ suggestions, projectedMarginPercent, notes });
    } catch (err) {
        console.error("AI Budget Fill error:", err);
        const message = err instanceof Error ? err.message : "Internal error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
