import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import * as fs from "fs";
import * as path from "path";

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

    // Load sample estimate PDFs as context
    let sampleContext = "";
    try {
        const samplesDir = path.join(process.cwd(), "estimatesamples");
        const samples = fs.readdirSync(samplesDir).filter(f => f.endsWith(".pdf"));
        sampleContext = `\nSAMPLE ESTIMATES AVAILABLE (${samples.length} files): ${samples.join(", ")}`;
        // Note: We reference the PDF names as context since we can't send binary PDF content directly to Gemini text API
    } catch (err) {
        console.warn("Could not read estimate samples:", err);
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

    const prompt = `You are an expert residential remodeling estimator and takeoff specialist in the Pacific Northwest. Generate a detailed, realistic construction estimate based on a takeoff analysis.

PROJECT: "${resolvedProjectName}"
TYPE: ${resolvedProjectType}
LOCATION: ${resolvedLocation}

TAKEOFF NAME: ${takeoff.name}
TAKEOFF DESCRIPTION: ${takeoff.description || "No additional description provided"}

UPLOADED PLAN FILES:
${fileDescriptions || "No files uploaded yet"}

${additionalContext ? `ADDITIONAL CONTEXT FROM MANAGER:\n${additionalContext}\n` : ""}
${sampleContext}
${pastEstimateContext}

AVAILABLE PHASES (use the code field exactly as shown):
${phasesList || "Use standard construction phases"}

AVAILABLE COST TYPES (use exactly as shown):
${typesList || "Labor, Material, Subcontractor, Equipment, Unit, Allowance, Other"}

INSTRUCTIONS:
- Analyze the takeoff description and project context to generate a realistic, comprehensive estimate
- Generate 15-40 line items organized by construction phase
- For each phase, create separate line items for each cost type (Labor, Material, Sub, etc.)
- Include realistic quantities with units (e.g., "240 sq ft", "1 job", "80 linear ft")
- Use accurate Pacific Northwest market rates (2024-2025 pricing)
- Include ALLOWANCE items for customer selections (fixtures, tile, countertops, appliances)
- If past estimates are provided, use those as pricing reference for similar items
- Consider the uploaded plan files when estimating quantities and scope

SAMPLE REFERENCE PRICING:
  * General labor: $45-65/hr
  * Skilled carpenter: $55-80/hr
  * Electrician sub: $85-120/hr
  * Plumber sub: $90-130/hr
  * Demolition: $1,500-4,000 per room
  * Drywall: $2.50-4.00/sq ft
  * Paint: $3.50-5.50/sq ft
  * Tile: $12-25/sq ft installed
  * Cabinets (mid-range): $250-450/linear ft
  * Countertops: $55-100/sq ft
  * Permits: $500-3,000 depending on scope

Return ONLY a JSON object:
{
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

Sort items by phase code, then by cost type within each phase.`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 55000);

        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
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
            console.error("Gemini API error:", errorText);
            return NextResponse.json({ error: "AI request failed" }, { status: 502 });
        }

        const geminiData = await geminiResponse.json();
        const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!rawText) {
            return NextResponse.json({ error: "No response from AI" }, { status: 502 });
        }

        let aiData: any;
        try {
            aiData = JSON.parse(rawText);
            if (Array.isArray(aiData)) {
                aiData = { items: aiData, paymentMilestones: [], summary: "" };
            }
        } catch {
            const objMatch = rawText.match(/\{[\s\S]*\}/);
            const arrMatch = rawText.match(/\[[\s\S]*\]/);
            if (objMatch) {
                aiData = JSON.parse(objMatch[0]);
                if (Array.isArray(aiData)) aiData = { items: aiData, paymentMilestones: [], summary: "" };
            } else if (arrMatch) {
                aiData = { items: JSON.parse(arrMatch[0]), paymentMilestones: [], summary: "" };
            } else {
                return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
            }
        }

        const aiItems = aiData.items || [];
        const aiMilestones = aiData.paymentMilestones || [];
        const aiSummary = aiData.summary || "";

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
            unitCost: item.unitCost || 0,
            total: item.total || (item.quantity || 1) * (item.unitCost || 0),
            parentId: null,
            costCodeId: codeMap[item.costCode] || null,
            costTypeId: typeMap[item.costType] || null,
            order: idx,
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
                aiEstimateData: JSON.stringify({ items: estimateItems, paymentMilestones, summary: aiSummary, totalEstimate }),
                status: "In Progress",
            },
        });

        return NextResponse.json({
            items: estimateItems,
            paymentMilestones,
            summary: aiSummary,
            count: estimateItems.length,
            totalEstimate,
        });
    } catch (err: any) {
        console.error("AI Takeoff Estimate error:", err);
        return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
    }
}
