import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import Anthropic from "@anthropic-ai/sdk";
import { extractJsonObject } from "@/lib/ai-json";

type ItemInput = {
  id: string;
  name: string;
  description: string;
};

type CostCodeInput = {
  id: string;
  code: string;
  name: string;
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

  let items: ItemInput[];
  let costCodes: CostCodeInput[];
  try {
    ({ items, costCodes } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items array is required" }, { status: 400 });
  }

  if (!costCodes || !Array.isArray(costCodes) || costCodes.length === 0) {
    return NextResponse.json({ error: "costCodes array is required" }, { status: 400 });
  }

  if (items.length > 500 || costCodes.length > 200) {
    return NextResponse.json({ error: "Too many items or cost codes" }, { status: 400 });
  }

  // Normalize and cap every field that reaches the prompt — count caps alone
  // don't bound prompt size, and null/non-string entries must not throw.
  const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const safeItems = items
    .filter((it) => !!it && typeof it === "object")
    .map((it) => ({ id: str(it.id, 100), name: str(it.name, 200), description: str(it.description, 500) }))
    .filter((it) => it.id);
  const safeCostCodes = costCodes
    .filter((cc) => !!cc && typeof cc === "object")
    .map((cc) => ({ id: str(cc.id, 100), code: str(cc.code, 50), name: str(cc.name, 100) }))
    .filter((cc) => cc.id);

  if (safeItems.length === 0 || safeCostCodes.length === 0) {
    return NextResponse.json({ error: "No valid items or cost codes" }, { status: 400 });
  }

  const itemsList = safeItems
    .map((item, i) =>
      `${i + 1}. ID: "${item.id}" | Name: "${item.name}"${item.description ? ` | Description: "${item.description}"` : ""}`)
    .join("\n");

  const codesList = safeCostCodes
    .map((cc) => `- Code: "${cc.code}" | Name: "${cc.name}" | ID: "${cc.id}"`)
    .join("\n");

  const prompt = `You are an expert construction estimator. Your job is to assign the best matching phase (cost code) to each estimate line item.

Available Phases:
${codesList}

Estimate Line Items to Assign:
${itemsList}

Rules:
- Select the best phase for each item based on its name and description.
- For example:
  - "Site Protection", "dust containment", "cleanup" -> 01-DEMO (Demolition) or 20-CLEAN (Cleanup & Disposal)
  - "studs", "framing", "joists", "wood" -> 02-FRAME (Framing)
  - "rough-in plumbing", "drain", "water line" -> 03-PLUMB (Plumbing)
  - "outlet", "switch", "wiring", "electrical panel" -> 04-ELEC (Electrical)
  - "HVAC", "exhaust fan", "ductwork" -> 05-HVAC (HVAC)
  - "insulation", "vapor barrier" -> 06-INSUL (Insulation)
  - "drywall", "taping", "sheetrock" -> 07-DRYWALL (Drywall)
  - "paint", "stain", "caulk" -> 08-PAINT (Paint & Finish)
  - "flooring", "lvp", "hardwood", "carpet" -> 09-FLOOR (Flooring)
  - "tile backsplash", "shower tile", "grout" -> 10-TILE (Tile Work)
  - "cabinet", "vanity", "pantry cabinet" -> 11-CABINET (Cabinetry)
  - "countertop", "quartz", "granite" -> 12-COUNTER (Countertops)
  - "trim", "millwork", "baseboard" -> 13-TRIM (Trim & Millwork)
  - "door", "window" -> 14-DOOR (Doors & Windows)
  - "roof", "roofing", "gutters" -> 15-ROOF (Roofing)
  - "siding", "housewrap" -> 16-SIDING (Siding & Exterior)
  - "concrete slab", "foundation", "footings" -> 17-CONCRETE (Concrete & Foundation)
  - "appliance", "range", "fridge", "dishwasher" -> 18-APPLIANCE (Appliances)
  - "sink", "faucet", "toilet", "bath accessories" -> 19-FIXTURE (Fixtures & Hardware)
- If a line item does not map to any specific category, assign it to the closest match or leave costCodeId as null.
- Return ONLY valid JSON in this exact shape. Do not include any conversational text or markdown blocks:
{
  "assignments": [
    {
      "id": "<exact id from input>",
      "costCodeId": "<the ID of the matched phase, or null if no match>"
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

    const block = response.content[0];
    const rawText = ("text" in block ? block.text : "").trim();
    if (!rawText) {
      return NextResponse.json({ error: "No response from AI" }, { status: 502 });
    }

    const parsed = extractJsonObject<any>(rawText);
    if (!parsed) {
      return NextResponse.json({ error: "Could not parse AI response" }, { status: 502 });
    }

    // Only trust IDs that were actually submitted — the model (or an injected
    // item description) must not be able to introduce arbitrary ids.
    const validItemIds = new Set(safeItems.map((i) => i.id));
    const validCostCodeIds = new Set(safeCostCodes.map((c) => c.id));
    const assignments = (parsed.assignments || [])
      .map((a: any) => ({
        id: String(a.id ?? ""),
        costCodeId: a.costCodeId ? String(a.costCodeId) : null,
      }))
      .filter((a: { id: string }) => validItemIds.has(a.id))
      .map((a: { id: string; costCodeId: string | null }) => ({
        id: a.id,
        costCodeId: a.costCodeId && validCostCodeIds.has(a.costCodeId) ? a.costCodeId : null,
      }));

    return NextResponse.json({ assignments });
  } catch (err) {
    console.error("AI Assign Phases error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
