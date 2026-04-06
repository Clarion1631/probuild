import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  const { mode, itemName, itemDescription, parentName, projectName, costType, existingItems } = await req.json();

  if (!mode) {
    return NextResponse.json({ error: "mode is required" }, { status: 400 });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    if (mode === "description") {
      // Suggest a description for a line item
      if (!itemName) {
        return NextResponse.json({ error: "itemName required for description mode" }, { status: 400 });
      }

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `You are a construction estimator. Write a brief, specific description (1-2 lines max) for this estimate line item.

Item Name: "${itemName}"
${costType ? `Cost Type: ${costType}` : ""}
${parentName ? `Parent Item: "${parentName}"` : ""}
${projectName ? `Project: "${projectName}"` : ""}

Return ONLY the description text, nothing else. Be specific and practical — include specs, materials, or scope details a contractor needs. Examples:
- "R-13 batt insulation, exterior walls, includes vapor barrier"
- "Remove existing tile, backerboard, and underlayment to subfloor"
- "Supply and install 3/4\" red oak hardwood, sand and finish 3 coats poly"`,
        }],
      });

      const block = response.content[0];
      const description = ("text" in block ? block.text : "").trim().replace(/^["']|["']$/g, "");
      return NextResponse.json({ description });
    }

    if (mode === "subitems") {
      // Suggest sub-items for a parent item
      if (!itemName) {
        return NextResponse.json({ error: "itemName required for subitems mode" }, { status: 400 });
      }

      const existingNames = (existingItems || []).map((i: any) => i.name).filter(Boolean).join(", ");

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: `You are a construction estimator. Suggest 3-5 sub-items that break down this line item into specific tasks/materials.

Parent Item: "${itemName}"
${projectName ? `Project: "${projectName}"` : ""}
${existingNames ? `Already exists in estimate: ${existingNames}` : ""}

Return ONLY a JSON array of objects with "name", "description", and "costType" (one of: Labor, Material, Subcontractor, Equipment, Unit, Allowance, Other).

Example for "Bathroom Tile":
[
  {"name": "Tile Material", "description": "12x24 porcelain floor tile, 60 sq ft + 10% waste", "costType": "Material"},
  {"name": "Tile Labor", "description": "Floor prep, layout, cut and set tile, grout", "costType": "Labor"},
  {"name": "Backer Board", "description": "1/4\" cement board underlayment, thinset and screws", "costType": "Material"},
  {"name": "Grout & Supplies", "description": "Sanded grout, spacers, thinset mortar, sealer", "costType": "Material"}
]

Be specific to residential remodeling in the Pacific Northwest. Return ONLY the JSON array.`,
        }],
      });

      const block2 = response.content[0];
      const rawText = ("text" in block2 ? block2.text : "").trim();
      let suggestions;
      try {
        suggestions = JSON.parse(rawText);
      } catch {
        const match = rawText.match(/\[[\s\S]*\]/);
        suggestions = match ? JSON.parse(match[0]) : [];
      }

      return NextResponse.json({ suggestions });
    }

    return NextResponse.json({ error: "Invalid mode. Use 'description' or 'subitems'" }, { status: 400 });
  } catch (err) {
    console.error("[AI Suggest] Error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
