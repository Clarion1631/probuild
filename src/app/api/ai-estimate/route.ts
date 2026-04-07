import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

type CostCode = { id: string; code: string; name: string };
type CostType = { id: string; name: string };
type AiItem = {
    name?: string;
    description?: string;
    costCode?: string;
    costType?: string;
    quantity?: number;
    unitCost?: number;
    total?: number;
};
type AiMilestone = { name?: string; percentage?: number };
type AiData = { items: AiItem[]; paymentMilestones: AiMilestone[] };

export const maxDuration = 300; // 5 min — Claude needs time for large estimates

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const { projectName, projectType, description, location, costCodes, costTypes } = await req.json();

    if (!projectName) {
        return NextResponse.json({ error: "projectName is required" }, { status: 400 });
    }

    // Build lists of available phases and cost types for the AI
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
- Generate a comprehensive estimate with 15-40 line items organized by phase
- For each phase that applies to this project, create separate line items for each cost type (Labor, Material, Sub, etc.)
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
  * Hardwood flooring: $8-15/sq ft installed
  * LVP flooring: $5-9/sq ft installed
  * Cabinets (mid-range): $250-450/linear ft
  * Granite/quartz countertops: $55-100/sq ft
  * Demolition: $1,500-4,000 per room
  * Permits: $500-3,000 depending on scope
- Include ALLOWANCE items for selections customers make (lighting fixtures, plumbing fixtures, tile, countertop material, appliances)
- Allowance items should use costType "Allowance" and have a realistic budget amount
- For unit pricing (combined labor + material), use costType "Unit"
- Group sub-items under parent items by phase when logical
- The "description" field should be brief but helpful (e.g., "R-13 batt insulation, exterior walls")

Also generate a payment milestone schedule (exactly 3-4 milestones, no more) based on standard construction draw schedules:
- Deposit upon signing (20-30%)
- Progress payment at rough-in completion (30-35%)
- Substantial completion (25-30%)
- Final walkthrough/completion (10-15%)

Return ONLY a JSON object (NOT an array) with two keys:

{
  "items": [
    {
      "name": string,
      "description": string,
      "costCode": string (the phase code, e.g. "01-DEMO"),
      "costType": string (exactly one of: ${typesList || "Labor, Material, Subcontractor, Equipment, Unit, Allowance, Other"}),
      "quantity": number,
      "unit": string (e.g. "sq ft", "hr", "each", "job", "linear ft"),
      "unitCost": number,
      "total": number,
      "isAllowance": boolean
    }
  ],
  "paymentMilestones": [
    {
      "name": string (e.g. "Deposit upon signing"),
      "percentage": number (e.g. 15)
    }
  ]
}

Sort items by phase code, then by cost type within each phase. Make the estimate thorough and professional.`;

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            messages: [{ role: "user", content: prompt }],
        });

        const textBlock = response.content.find(b => b.type === 'text');
        const rawText = textBlock && 'text' in textBlock ? (textBlock as any).text as string : '';

        if (!rawText) {
            return NextResponse.json({ error: "No response from AI" }, { status: 502 });
        }

        let aiData: AiData;
        try {
            aiData = JSON.parse(rawText);
            // Handle both object format { items: [...], paymentMilestones: [...] } and legacy array format
            if (Array.isArray(aiData)) {
                aiData = { items: aiData, paymentMilestones: [] };
            }
        } catch {
            // Try to extract JSON object or array
            const objMatch = rawText.match(/\{[\s\S]*\}/);
            const arrMatch = rawText.match(/\[[\s\S]*\]/);
            if (objMatch) {
                aiData = JSON.parse(objMatch[0]);
                if (Array.isArray(aiData)) aiData = { items: aiData, paymentMilestones: [] };
            } else if (arrMatch) {
                aiData = { items: JSON.parse(arrMatch[0]), paymentMilestones: [] };
            } else {
                return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
            }
        }

        const aiItems = aiData.items || [];
        const aiMilestones = aiData.paymentMilestones || [];

        // Map cost codes and cost types to IDs
        const codeMap: Record<string, string> = {};
        for (const cc of (costCodes || [])) {
            codeMap[cc.code] = cc.id;
        }

        const typeMap: Record<string, string> = {};
        for (const ct of (costTypes || [])) {
            typeMap[ct.name] = ct.id;
        }

        // Transform AI items into estimate items structure
        const estimateItems = aiItems.map((item: AiItem, idx: number) => ({
            id: `ai_${Date.now()}_${idx}`,
            name: item.name || "Unnamed Item",
            description: item.description || "",
            type: item.costType || "Material",
            quantity: item.quantity || 1,
            unitCost: item.unitCost || 0,
            total: item.total || (item.quantity || 1) * (item.unitCost || 0),
            parentId: null,
            costCodeId: item.costCode ? (codeMap[item.costCode] || null) : null,
            costTypeId: item.costType ? (typeMap[item.costType] || null) : null,
            order: idx,
        }));

        const totalEstimate = estimateItems.reduce((sum: number, i) => sum + (i.total || 0), 0);

        // Build payment milestones with amounts based on total
        const paymentMilestones = aiMilestones.map((m: AiMilestone, idx: number) => ({
            id: `pm_${Date.now()}_${idx}`,
            name: m.name || `Payment ${idx + 1}`,
            percentage: String(m.percentage || 0),
            amount: ((m.percentage || 0) / 100 * totalEstimate).toFixed(2),
            dueDate: "",
        }));

        return NextResponse.json({
            items: estimateItems,
            paymentMilestones,
            count: estimateItems.length,
            totalEstimate,
        });
    } catch (err) {
        console.error("AI Estimate error:", err);
        const message = err instanceof Error ? err.message : "Internal error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
