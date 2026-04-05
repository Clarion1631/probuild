import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
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
                return `Estimate "${est.title}" (${est.project?.type || "General"}, $${Number(est.totalAmount).toLocaleString()}):\n${itemSummary}`;
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

    // Build content blocks — include images and PDFs via Claude's vision/document API
    type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } };
    type DocumentBlock = { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };
    type TextBlock = { type: "text"; text: string };
    type ContentBlock = ImageBlock | DocumentBlock | TextBlock;

    const contentBlocks: ContentBlock[] = [];

    const imageFiles = takeoff.files.filter(f => f.mimeType.startsWith("image/"));
    const pdfFiles = takeoff.files.filter(f => f.mimeType === "application/pdf");

    // For image files, fetch and include as inline data
    for (const img of imageFiles.slice(0, 4)) {
        try {
            const imgResp = await fetch(img.url);
            if (imgResp.ok) {
                const buffer = await imgResp.arrayBuffer();
                const base64 = Buffer.from(buffer).toString("base64");
                const rawMime = img.mimeType;
                const safeMime = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(rawMime)
                    ? rawMime
                    : "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
                contentBlocks.push({
                    type: "image",
                    source: { type: "base64", media_type: safeMime, data: base64 },
                });
            }
        } catch (err) {
            console.warn(`Could not fetch image ${img.name}:`, err);
        }
    }

    // For PDF files, fetch and include as document blocks
    for (const pdf of pdfFiles.slice(0, 3)) {
        try {
            const pdfResp = await fetch(pdf.url);
            if (pdfResp.ok) {
                const buffer = await pdfResp.arrayBuffer();
                const base64 = Buffer.from(buffer).toString("base64");
                contentBlocks.push({
                    type: "document",
                    source: { type: "base64", media_type: "application/pdf", data: base64 },
                });
            }
        } catch (err) {
            console.warn(`Could not fetch PDF ${pdf.name}:`, err);
        }
    }

    const textPrompt = `You are an expert residential remodeling estimator and takeoff specialist based in Clark County, Washington (Vancouver, WA metro area). You work for Golden Touch Remodeling. You are analyzing construction/architect plans to generate a detailed, accurate estimate.

IMPORTANT LOCATION CONTEXT:
- Clark County, WA is in the Portland-Vancouver metropolitan area
- Washington State has NO income tax, but higher property taxes and WA sales tax (8.4% in Clark County)
- Labor rates in Clark County tend to be 5-10% higher than national averages due to cost of living and no income tax
- Material costs reflect Pacific Northwest pricing (lumber is local/competitive, but specialty items may cost more due to shipping)
- Permits are handled by Clark County Community Development — building permits typically run $800-4,000 for remodels
- If a zip code is provided, use it to fine-tune pricing for that specific neighborhood

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
${phasesList || "Use standard construction phases: 00-GC (General Conditions), 01-DEMO, 02-FRAME, 03-PLUMB, 04-ELEC, 05-HVAC, 06-INSUL, 07-DRYWALL, 08-PAINT, 09-FLOOR, 10-CABINET, 11-COUNTER, 12-TILE, 13-FINISH, 14-CLEAN, 15-PERMIT, 99-TAX"}

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
- Generate 20-50 detailed line items organized by construction phase
- For each phase, create separate line items for each cost type (Labor, Material, Sub, etc.)
- Include realistic quantities WITH UNITS derived from the plans (e.g., "240 sq ft", "14 linear ft of cabinets", "80 linear ft baseboard")
- Use accurate CLARK COUNTY, WA market rates (2024-2025 pricing) — adjust for local cost of living
- Include ALLOWANCE items for customer selections (lighting fixtures, plumbing fixtures, tile, countertop material, appliances)

CLARK COUNTY, WA PRICING REFERENCE (2024-2025):
  * General labor: $50-70/hr (WA rates, no income tax adjustment)
  * Skilled carpenter: $60-85/hr
  * Electrician sub: $90-130/hr
  * Plumber sub: $95-140/hr
  * HVAC sub: $100-150/hr
  * Demolition: $1,800-4,500 per room
  * Drywall: $3.00-4.50/sq ft (material + labor)
  * Paint: $4.00-6.00/sq ft (includes prep, prime, 2 coats)
  * Tile: $14-28/sq ft installed
  * Hardwood flooring: $9-16/sq ft installed
  * LVP flooring: $6-10/sq ft installed
  * Cabinets (mid-range): $275-500/linear ft
  * Granite/quartz countertops: $60-110/sq ft (fabricated + installed)
  * Permits (Clark County): $800-4,000 depending on scope

PRICING STRATEGY — HOW A REAL CONTRACTOR BIDS:

1. OVERHEAD & PROFIT — BAKE IT IN (NEVER show as a separate line item):
   * ALL unit costs and line item prices should ALREADY INCLUDE 20-25% overhead & profit markup
   * For EACH line item, you MUST provide:
     - baseCost: the RAW contractor cost (what you actually pay — labor rate, material cost, sub cost)
     - markupPercent: the markup percentage (default 25% for most items, but 0 for TAX items)
     - unitCost: the SELL PRICE shown to client = baseCost × (1 + markupPercent/100)
     - total: unitCost × quantity
   * Example: If a carpenter costs $65/hr, baseCost=65, markupPercent=25, unitCost=81.25, quantity=40, total=3250
   * TAX ITEMS: Sales tax MUST have markupPercent=0 (tax is a pass-through, no markup). Set costCode starting with "99-TAX".
   * Overhead covers: office, insurance (GL/auto/umbrella), WA contractor bond, vehicles, licensing, accounting, warranty reserve, and profit
   * The client only sees unitCost and total — baseCost and markupPercent are internal

2. CONTINGENCY — BUILT INTO PRICING (NOT a separate line item):
   * Build a reasonable buffer into your line item pricing (the unit costs already have room for this)
   * Remodel unknowns (rot, old wiring, plumbing surprises) are handled through change orders if/when discovered
   * Do NOT add a visible "Contingency" line item — it looks unprofessional to clients

3. GENERAL CONDITIONS (phase 00-GC) — Only REAL pass-through costs:
   * Dumpster rental (20-30 yard, $450-800 per haul) — visible, real cost
   * Portable toilet rental if needed ($150-250/month) — visible, real cost
   * Temporary protections (floor protection, dust barriers: $300-800) — visible, real cost
   * Final construction cleaning ($200-600) — visible, real cost
   * DO NOT include "Project Management" or "Superintendent" as line items — that's part of overhead, already baked into every line item's price

4. WA L&I / WORKERS' COMPENSATION:
   * Already included in the hourly labor rates above
   * DO NOT show as a separate line item

5. PERMITS & INSPECTIONS (phase 15-PERMIT):
   * Clark County building permit (real pass-through cost based on project valuation)
   * Plan review fees
   * These are legitimately separate because they're paid directly to the county

IMPORTANT — WA SALES TAX:
- In Washington State, residential remodeling/construction is classified as a RETAIL SALE
- Clark County WA sales tax rate is 8.4%
- The 8.4% tax applies to the ENTIRE CONTRACT PRICE
- Add ONE SEPARATE line item at the end: "WA Sales Tax (8.4%)" in phase "99-TAX", type "Other"
- Calculate: tax = 8.4% × (sum of ALL other line item totals)
- All other line items are pre-tax
- The totalEstimate MUST INCLUDE the tax line item

ESTIMATE STRUCTURE:
  Construction line items (phases 00-15, with O&P already baked into each price)
  + WA Sales Tax (8.4% of the above total)
  = TOTAL ESTIMATE (this is totalEstimate)

PAYMENT MILESTONES — Use WA residential remodeling industry standard:
- "Deposit / Contract Signing": 10% (due at signing)
- "Demolition & Rough-In Complete": 25% (due when demo and rough framing/plumbing/electrical done)
- "Mid-Project / Drywall & Mechanical": 25% (due when drywall hung, HVAC complete)
- "Finish Work / Cabinets & Counters": 25% (due when cabinets, counters, tile, paint complete)
- "Final Completion & Walkthrough": 15% (due after final inspection, punchlist, and client walkthrough)
Note: Each milestone amount = percentage × totalEstimate (tax-inclusive total). Percentages must sum to 100%.

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
      "baseCost": number,
      "markupPercent": number,
      "unitCost": number,
      "total": number,
      "isAllowance": boolean
    }
  ],
  "paymentMilestones": [
    {
      "name": string,
      "percentage": number,
      "amount": number
    }
  ],
  "summary": string
}

Sort items by phase code, then by cost type within each phase. Be thorough and professional.`;

    contentBlocks.push({ type: "text", text: textPrompt });

    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 8192,
            messages: [{ role: "user", content: contentBlocks as any }],
        });

        const rawText = (response.content[0] as { type: "text"; text: string }).text;

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
    } catch (err: any) {
        console.error("AI Takeoff Estimate error:", err);
        return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
    }
}
