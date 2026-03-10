import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
    }

    const { projectName, projectType, description, location, costCodes, costTypes } = await req.json();

    if (!projectName) {
        return NextResponse.json({ error: "projectName is required" }, { status: 400 });
    }

    // Build lists of available phases and cost types for the AI
    const phasesList = (costCodes || []).map((cc: any) => `${cc.code} — ${cc.name}`).join("\n");
    const typesList = (costTypes || []).map((ct: any) => ct.name).join(", ");

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

Return ONLY a JSON array of objects. Each object must have exactly these fields:
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

Sort items by phase code, then by cost type within each phase. Make the estimate thorough and professional.`;

    try {
        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.7,
                        responseMimeType: "application/json",
                    },
                }),
            }
        );

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            console.error("Gemini API error:", errorText);
            return NextResponse.json({ error: "AI request failed" }, { status: 502 });
        }

        const geminiData = await geminiResponse.json();
        const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawText) {
            return NextResponse.json({ error: "No response from AI" }, { status: 502 });
        }

        let aiItems: any[];
        try {
            aiItems = JSON.parse(rawText);
            if (!Array.isArray(aiItems)) throw new Error("Not an array");
        } catch {
            const match = rawText.match(/\[[\s\S]*\]/);
            if (!match) {
                return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
            }
            aiItems = JSON.parse(match[0]);
        }

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
        const estimateItems = aiItems.map((item: any, idx: number) => ({
            id: `ai_${Date.now()}_${idx}`,
            name: item.name || "Unnamed Item",
            description: item.description || "",
            type: item.costType || "Material",
            quantity: item.quantity || 1,
            unitCost: item.unitCost || 0,
            total: item.total || (item.quantity || 1) * (item.unitCost || 0),
            parentId: null,
            costCodeId: codeMap[item.costCode] || null,
            costTypeId: typeMap[item.costType] || null,
            order: idx,
        }));

        return NextResponse.json({
            items: estimateItems,
            count: estimateItems.length,
            totalEstimate: estimateItems.reduce((sum: number, i: any) => sum + (i.total || 0), 0),
        });
    } catch (err: any) {
        console.error("AI Estimate error:", err);
        return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
    }
}
