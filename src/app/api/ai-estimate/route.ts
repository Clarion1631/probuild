import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAnthropicText } from "@/lib/anthropic";
import Anthropic from "@anthropic-ai/sdk";
import { transformPhasesToItems, type AiData, type CostCode, type CostType } from "@/lib/ai-estimate-transform";

export const maxDuration = 300; // 5 min — Claude needs time for large estimates

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const { projectName, projectType, description, location, costCodes, costTypes } = await req.json();

    if (!projectName) {
        return NextResponse.json({ error: "projectName is required" }, { status: 400 });
    }

    const phasesList = (costCodes || []).map((cc: CostCode) => `${cc.code} — ${cc.name}`).join("\n");
    const typesList = (costTypes || []).map((ct: CostType) => ct.name).join(", ");

    const prompt = `You are an expert residential remodeling estimator in Vancouver, WA (Clark County). Generate a detailed, realistic construction estimate with accurate 2024-2025 local market pricing.

PROJECT: "${projectName}"
TYPE: ${projectType || "General Remodeling"}
DESCRIPTION: ${description || "Standard residential remodel"}
LOCATION: ${location || "Vancouver, WA"}

AVAILABLE PHASES (use the code field exactly as shown):
${phasesList || "Use standard construction phases"}

AVAILABLE COST TYPES (use exactly as shown):
${typesList || "Labor, Material, Subcontractor, Equipment, Unit, Allowance, Other"}

INSTRUCTIONS:
- Organize the estimate into 6-12 phases that apply to this project
- Each phase has 2-5 line items covering its major cost types (Labor, Material, Subcontractor, etc.)
- This gives a clean grouped structure — typically 20-40 total line items
- Include realistic quantities with units (e.g., "240 sq ft", "1 job", "80 linear ft")
- Use accurate Vancouver, WA / Pacific Northwest market rates:
  * General labor: $45-65/hr
  * Skilled carpenter: $55-80/hr
  * Electrician sub: $85-120/hr
  * Plumber sub: $90-130/hr
  * HVAC sub: $95-140/hr
  * Drywall: $2.50-4.00/sq ft (material + labor)
  * Paint: $3.50-5.50/sq ft
  * Tile: $12-25/sq ft installed
  * LVP flooring: $5-9/sq ft installed
  * Cabinets (mid-range): $250-450/linear ft
  * Granite/quartz countertops: $55-100/sq ft
  * Demolition: $1,500-4,000 per room
  * Permits: $500-3,000 depending on scope
- Include ALLOWANCE items for customer selections (fixtures, finishes, appliances) — use costType "Allowance"
- The "description" field should be brief but helpful (e.g., "R-13 batt insulation, exterior walls")

Also generate a payment milestone schedule (exactly 3-4 milestones) based on standard construction draws:
- Deposit upon signing (20-30%)
- Progress payment at rough-in completion (30-35%)
- Substantial completion (25-30%)
- Final walkthrough/completion (10-15%)

Return ONLY a valid JSON object with this exact structure:

{
  "phases": [
    {
      "phaseName": string (e.g. "Demolition"),
      "phaseCode": string (the phase code exactly as given, e.g. "01-DEMO"),
      "items": [
        {
          "name": string,
          "description": string,
          "costType": string (exactly one of: ${typesList || "Labor, Material, Subcontractor, Equipment, Unit, Allowance, Other"}),
          "quantity": number,
          "unit": string (e.g. "sq ft", "hr", "each", "job", "linear ft"),
          "unitCost": number
        }
      ]
    }
  ],
  "paymentMilestones": [
    {
      "name": string,
      "percentage": number
    }
  ]
}

Sort phases in logical construction order. Make the estimate thorough and professional.`;

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 8000,
            messages: [{ role: "user", content: prompt }],
        });

        const rawText = getAnthropicText(response.content);

        if (!rawText) {
            return NextResponse.json({ error: "No response from AI" }, { status: 502 });
        }

        if (response.stop_reason === 'max_tokens') {
            console.error(`[ai-estimate] Response truncated at ${rawText.length} chars — increase max_tokens`);
            return NextResponse.json({ error: "AI response was cut off. Try a shorter description." }, { status: 502 });
        }

        let aiData: AiData;
        try {
            const parsed = JSON.parse(rawText);
            if (Array.isArray(parsed)) {
                return NextResponse.json({ error: "AI returned wrong format — please retry" }, { status: 502 });
            }
            aiData = parsed;
        } catch {
            const objMatch = rawText.match(/\{[\s\S]*\}/);
            if (objMatch) {
                aiData = JSON.parse(objMatch[0]);
            } else {
                return NextResponse.json({ error: "Could not parse AI response as JSON" }, { status: 502 });
            }
        }

        // Transform AI phases into the grouped estimate-item structure the editor expects.
        const result = transformPhasesToItems(aiData, costCodes || [], costTypes || []);
        return NextResponse.json(result);
    } catch (err) {
        console.error("AI Estimate error:", err);
        const message = err instanceof Error ? err.message : "Internal error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
