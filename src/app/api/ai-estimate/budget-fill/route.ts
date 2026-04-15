import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAnthropicText } from "@/lib/anthropic";
import Anthropic from "@anthropic-ai/sdk";

type ItemInput = {
    id: string;
    name: string;
    description: string;
    type: string;
    quantity: number;
    unitCost: number;
    budgetRate: number | string | null;
    budgetUnit: string | null;
};

type Suggestion = {
    id: string;
    budgetRate: number;
    budgetUnit: string;
    budgetQuantity: number;
    marginPercent: number;
    confidence: "high" | "medium" | "low";
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

    const { items, projectContext, location } = await req.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
        return NextResponse.json({ error: "items array is required" }, { status: 400 });
    }

    if (items.length > 50) {
        return NextResponse.json({ error: "Too many items (max 50 per request)" }, { status: 400 });
    }

    const itemsList = items.map((item: ItemInput, i: number) =>
        `${i + 1}. ID: "${item.id}" | Name: "${item.name}" | Type: ${item.type} | Qty: ${item.quantity} | Unit: ${item.budgetUnit || "ea"} | Current sell price: $${item.unitCost || 0}/unit | Description: "${item.description}"`
    ).join("\n");

    const prompt = `You are an expert residential remodeling cost estimator in ${location || "Vancouver, WA"} (Pacific Northwest). Given the following estimate line items, suggest realistic internal budget rates (what the contractor actually pays) and target margin percentages.

PROJECT CONTEXT: ${projectContext || "Residential remodel"}

MARKET RATE REFERENCE (${location || "Vancouver, WA"} 2024-2025):
- General labor: $45-65/hr
- Skilled carpenter: $55-80/hr
- Electrician sub: $85-120/hr
- Plumber sub: $90-130/hr
- HVAC sub: $95-140/hr
- Drywall: $2.50-4.00/sq ft (material + labor)
- Paint: $3.50-5.50/sq ft
- Tile: $12-25/sq ft installed
- LVP flooring: $5-9/sq ft installed
- Cabinets (mid-range): $250-450/linear ft
- Granite/quartz countertops: $55-100/sq ft
- Demolition: $1,500-4,000 per room
- Permits: $500-3,000 depending on scope
- Lumber framing: $3-6/linear ft
- Insulation (batt): $1.50-3.00/sq ft
- Roofing: $4-8/sq ft
- Concrete: $8-15/sq ft
- Windows (mid-range): $400-900/each installed

ITEMS NEEDING BUDGET:
${itemsList}

INSTRUCTIONS:
- budgetRate = what the contractor actually PAYS (cost), not the sell price
- If the item already has a sell price (unitCost > 0), suggest a budgetRate that produces 20-35% margin
- If no sell price, suggest a realistic cost rate and 25% default margin
- budgetQuantity should match the item quantity unless there's a reason to differ (e.g., waste factor)
- Confidence: "high" for common items with well-known rates, "medium" for items where rates vary, "low" for unusual/custom items
- Keep reasoning to 1 short sentence

Return ONLY a valid JSON object:
{
  "suggestions": [
    {
      "id": string (exact item ID from input),
      "budgetRate": number,
      "budgetUnit": string,
      "budgetQuantity": number,
      "marginPercent": number (20-35 typical),
      "confidence": "high" | "medium" | "low",
      "reasoning": string
    }
  ]
}`;

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4000,
            messages: [{ role: "user", content: prompt }],
        });

        const rawText = getAnthropicText(response.content);
        if (!rawText) {
            return NextResponse.json({ error: "No response from AI" }, { status: 502 });
        }

        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            const objMatch = rawText.match(/\{[\s\S]*\}/);
            if (objMatch) {
                parsed = JSON.parse(objMatch[0]);
            } else {
                return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
            }
        }

        const suggestions: Suggestion[] = (parsed.suggestions || []).map((s: any) => ({
            id: s.id,
            budgetRate: parseFloat(s.budgetRate) || 0,
            budgetUnit: s.budgetUnit || "ea",
            budgetQuantity: parseFloat(s.budgetQuantity) || 1,
            marginPercent: Math.min(Math.max(parseFloat(s.marginPercent) || 25, 5), 50),
            confidence: ["high", "medium", "low"].includes(s.confidence) ? s.confidence : "medium",
            reasoning: s.reasoning || "",
        }));

        return NextResponse.json({ suggestions });
    } catch (err) {
        console.error("AI Budget Fill error:", err);
        const message = err instanceof Error ? err.message : "Internal error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
