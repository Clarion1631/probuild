import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
    }

    const body = await req.json();
    const { takeoffId, additionalContext, projectName, projectType, location } = body;

    if (!takeoffId) {
        return NextResponse.json({ error: "takeoffId is required" }, { status: 400 });
    }

    // Fetch the takeoff and its files
    const takeoff = await prisma.takeoff.findUnique({
        where: { id: takeoffId },
        include: {
            files: true,
            project: { select: { name: true, type: true, location: true } },
            lead: { select: { name: true, projectType: true, location: true } },
        },
    });

    if (!takeoff) {
        return NextResponse.json({ error: "Takeoff not found" }, { status: 404 });
    }

    // Fetch past estimates for pricing context
    let pastEstimateContext = "";
    try {
        const pastEstimates = await prisma.estimate.findMany({
            take: 10,
            orderBy: { createdAt: "desc" },
            include: {
                items: { take: 20, orderBy: { order: "asc" } },
                project: { select: { name: true, type: true } },
            },
        });

        if (pastEstimates.length > 0) {
            const summaries = pastEstimates.map(est => {
                const itemSummary = est.items.slice(0, 10).map(i => 
                    `  - ${i.name}: qty ${i.quantity} × $${i.unitCost} = $${i.total}`
                ).join("\n");
                return `Estimate "${est.title}" (${est.project?.type || "General"}, $${est.totalAmount.toLocaleString()}):\n${itemSummary}`;
            }).join("\n\n");
            pastEstimateContext = `\n\nPAST ESTIMATES IN OUR SYSTEM (use these for pricing reference):\n${summaries}`;
        }
    } catch (err) {
        console.warn("Could not fetch past estimates:", err);
    }

    // Get cost codes and types
    const costCodes = await prisma.costCode.findMany({ where: { isActive: true } });
    const costTypes = await prisma.costType.findMany({ where: { isActive: true } });

    const phasesList = costCodes.map(cc => `${cc.code} — ${cc.name}`).join("\n");
    const typesList = costTypes.map(ct => ct.name).join(", ");

    // Build file descriptions
    const fileDescriptions = takeoff.files.map(f => 
        `- ${f.name} (${f.mimeType}, ${(f.size / 1024).toFixed(0)}KB)`
    ).join("\n");

    const resolvedProjectName = projectName || takeoff.project?.name || takeoff.lead?.name || takeoff.name;
    const resolvedProjectType = projectType || takeoff.project?.type || takeoff.lead?.projectType || "General Remodeling";
    const resolvedLocation = location || takeoff.project?.location || takeoff.lead?.location || "Vancouver, WA";

    // Build the prompt parts — we'll send plan images to Gemini Vision if available
    const parts: any[] = [];

    // Try to include uploaded images directly in the Gemini request (vision capability)
    const imageFiles = takeoff.files.filter(f => f.mimeType.startsWith("image/"));
    const pdfFiles = takeoff.files.filter(f => f.mimeType === "application/pdf");

    // For image files, fetch and include as inline data
    for (const img of imageFiles.slice(0, 4)) {
        try {
            const imgResp = await fetch(img.url);
            if (imgResp.ok) {
                const buffer = await imgResp.arrayBuffer();
                const base64 = Buffer.from(buffer).toString("base64");
                parts.push({
                    inlineData: {
                        mimeType: img.mimeType,
                        data: base64,
                    }
                });
            }
        } catch (err) {
            console.warn(`Could not fetch image ${img.name}:`, err);
        }
    }

    // For PDF files, fetch and include as inline data (Gemini supports PDF)
    for (const pdf of pdfFiles.slice(0, 3)) {
        try {
            const pdfResp = await fetch(pdf.url);
            if (pdfResp.ok) {
                const buffer = await pdfResp.arrayBuffer();
                const base64 = Buffer.from(buffer).toString("base64");
                parts.push({
                    inlineData: {
                        mimeType: "application/pdf",
                        data: base64,
                    }
                });
            }
        } catch (err) {
            console.warn(`Could not fetch PDF ${pdf.name}:`, err);
        }
    }

    const textPrompt = `You are an expert residential remodeling estimator and takeoff specialist in the Pacific Northwest (Vancouver, WA / Portland, OR metro area). You are analyzing construction/architect plans to generate a detailed, accurate estimate.

PROJECT: "${resolvedProjectName}"
TYPE: ${resolvedProjectType}
LOCATION: ${resolvedLocation}

TAKEOFF NAME: ${takeoff.name}
TAKEOFF DESCRIPTION: ${takeoff.description || "No additional description provided"}

UPLOADED PLAN FILES:
${fileDescriptions || "No files uploaded yet"}

${additionalContext ? `ADDITIONAL CONTEXT FROM MANAGER:\n${additionalContext}\n` : ""}
${pastEstimateContext}

AVAILABLE PHASES (use the code field exactly as shown):
${phasesList || "Use standard construction phases like 01-DEMO, 02-FRAME, 03-PLUMB, 04-ELEC, 05-HVAC, 06-INSUL, 07-DRYWALL, 08-PAINT, 09-FLOOR, 10-CABINET, 11-COUNTER, 12-TILE, 13-FINISH, 14-CLEAN, 15-PERMIT"}

AVAILABLE COST TYPES (use exactly as shown):
${typesList || "Labor, Material, Subcontractor, Equipment, Unit, Allowance, Other"}

CRITICAL INSTRUCTIONS:
- If architect plans/images are provided above, CAREFULLY ANALYZE THEM to identify:
  * Room dimensions and square footage
  * Wall lengths for cabinets, countertops, backsplash
  * Number of plumbing fixtures (sinks, toilets, tubs, showers)
  * Electrical requirements (outlets, switches, lighting fixtures)
  * Window and door openings
  * Any demolition scope visible
  * Finish specifications noted on plans
- Generate 15-40 detailed line items organized by construction phase
- For each phase, create separate line items for each cost type (Labor, Material, Sub, etc.)
- Include realistic quantities WITH UNITS derived from the plans (e.g., "240 sq ft", "14 linear ft of cabinets", "80 linear ft baseboard")
- Use accurate Pacific Northwest market rates (2024-2025 pricing)
- Include ALLOWANCE items for customer selections (lighting fixtures, plumbing fixtures, tile, countertop material, appliances)

PRICING REFERENCE:
  * General labor: $45-65/hr
  * Skilled carpenter: $55-80/hr
  * Electrician sub: $85-120/hr  
  * Plumber sub: $90-130/hr
  * HVAC sub: $95-140/hr
  * Demolition: $1,500-4,000 per room
  * Drywall: $2.50-4.00/sq ft (material + labor)
  * Paint: $3.50-5.50/sq ft
  * Tile: $12-25/sq ft installed
  * Hardwood flooring: $8-15/sq ft installed
  * LVP flooring: $5-9/sq ft installed
  * Cabinets (mid-range): $250-450/linear ft
  * Granite/quartz countertops: $55-100/sq ft
  * Permits: $500-3,000 depending on scope

Also generate a "planAnalysis" object describing what you detected from the plans.

Return ONLY a JSON object:
{
  "planAnalysis": {
    "roomDimensions": string,
    "totalSqFt": number,
    "detectedItems": [string],
    "scopeNotes": string
  },
  "items": [
    {
      "name": string,
      "description": string,
      "costCode": string,
      "costType": string,
      "quantity": number,
      "unit": string,
      "unitCost": number,
      "total": number,
      "isAllowance": boolean
    }
  ],
  "paymentMilestones": [
    {
      "name": string,
      "percentage": number
    }
  ],
  "summary": string
}

Sort items by phase code, then by cost type within each phase. Be thorough and professional.`;

    parts.push({ text: textPrompt });

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000); // 90s for vision

        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: {
                        temperature: 0.7,
                        responseMimeType: "application/json",
                    },
                }),
            }
        );

        clearTimeout(timeout);

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            console.error("Gemini API error:", geminiResponse.status, errorText);
            
            // Fallback: try with gemini-1.5-flash if 2.0 fails
            const fallbackResponse = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts }],
                        generationConfig: {
                            temperature: 0.7,
                            responseMimeType: "application/json",
                        },
                    }),
                }
            );

            if (!fallbackResponse.ok) {
                const fbError = await fallbackResponse.text();
                console.error("Fallback Gemini API error:", fbError);
                return NextResponse.json({ error: "AI request failed — check API key and model availability", detail: fbError }, { status: 502 });
            }

            // Use fallback response
            return processGeminiResponse(fallbackResponse, takeoffId, costCodes, costTypes);
        }

        return processGeminiResponse(geminiResponse, takeoffId, costCodes, costTypes);
    } catch (err: any) {
        console.error("AI Takeoff Estimate error:", err);
        return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
    }
}

async function processGeminiResponse(geminiResponse: Response, takeoffId: string, costCodes: any[], costTypes: any[]) {
    const geminiData = await geminiResponse.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
        return NextResponse.json({ error: "No response from AI" }, { status: 502 });
    }

    let aiData: any;
    try {
        aiData = JSON.parse(rawText);
        if (Array.isArray(aiData)) {
            aiData = { items: aiData, paymentMilestones: [], summary: "", planAnalysis: null };
        }
    } catch {
        const objMatch = rawText.match(/\{[\s\S]*\}/);
        const arrMatch = rawText.match(/\[[\s\S]*\]/);
        if (objMatch) {
            aiData = JSON.parse(objMatch[0]);
            if (Array.isArray(aiData)) aiData = { items: aiData, paymentMilestones: [], summary: "", planAnalysis: null };
        } else if (arrMatch) {
            aiData = { items: JSON.parse(arrMatch[0]), paymentMilestones: [], summary: "", planAnalysis: null };
        } else {
            return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
        }
    }

    const aiItems = aiData.items || [];
    const aiMilestones = aiData.paymentMilestones || [];
    const aiSummary = aiData.summary || "";
    const planAnalysis = aiData.planAnalysis || null;

    // Map cost codes and cost types to IDs
    const codeMap: Record<string, string> = {};
    for (const cc of costCodes) codeMap[cc.code] = cc.id;

    const typeMap: Record<string, string> = {};
    for (const ct of costTypes) typeMap[ct.name] = ct.id;

    const estimateItems = aiItems.map((item: any, idx: number) => ({
        id: `ai_${Date.now()}_${idx}`,
        name: item.name || "Unnamed Item",
        description: item.description || "",
        type: item.costType || "Material",
        quantity: item.quantity || 1,
        unit: item.unit || "each",
        unitCost: item.unitCost || 0,
        total: item.total || (item.quantity || 1) * (item.unitCost || 0),
        parentId: null,
        costCodeId: codeMap[item.costCode] || null,
        costTypeId: typeMap[item.costType] || null,
        costCode: item.costCode || "",
        order: idx,
        isAllowance: item.isAllowance || false,
    }));

    const totalEstimate = estimateItems.reduce((sum: number, i: any) => sum + (i.total || 0), 0);

    const paymentMilestones = aiMilestones.map((m: any, idx: number) => ({
        id: `pm_${Date.now()}_${idx}`,
        name: m.name || `Payment ${idx + 1}`,
        percentage: String(m.percentage || 0),
        amount: ((m.percentage || 0) / 100 * totalEstimate).toFixed(2),
        dueDate: "",
    }));

    // Save the AI data to the takeoff
    await prisma.takeoff.update({
        where: { id: takeoffId },
        data: {
            aiEstimateData: JSON.stringify({ items: estimateItems, paymentMilestones, summary: aiSummary, totalEstimate, planAnalysis }),
            status: "In Progress",
        },
    });

    return NextResponse.json({
        items: estimateItems,
        paymentMilestones,
        summary: aiSummary,
        planAnalysis,
        count: estimateItems.length,
        totalEstimate,
    });
}
