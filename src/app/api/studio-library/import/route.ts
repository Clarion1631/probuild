// /api/studio-library/import — AI extraction of finishes/products from pasted
// catalog text (a vendor PDF's text, a Home Depot/Lowe's product page, a
// spec sheet email...). Returns CANDIDATES for the user to review; nothing is
// saved until they confirm via POST /api/studio-library.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MESH_KEYS, CATEGORY_ORDER } from "@/lib/studio/catalog";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const EXTRACT_TOOL = {
    name: "save_catalog_entries",
    description: "Save the finishes and products extracted from the vendor catalog text.",
    input_schema: {
        type: "object" as const,
        properties: {
            finishes: {
                type: "array",
                description:
                    "Color/material LINES (cabinet door styles, paint colors, flooring lines, countertop materials, tile lines). Use for entries that describe a look, not a sized object.",
                items: {
                    type: "object",
                    properties: {
                        kind: { type: "string", enum: ["cabinet", "paint", "floor", "counter", "tile"] },
                        name: { type: "string", description: "The line/style name, e.g. 'Aspen White Shaker'" },
                        hex: { type: "string", description: "Best-guess sRGB hex like #EDEAE0 inferred from the name/description. White shaker = warm white, espresso = dark brown, etc." },
                        vendor: { type: "string" },
                        sku: { type: "string" },
                        priceNote: { type: "string", description: "Pricing/lead-time note if stated, e.g. 'RTA + Pre-assembled, ships 5-15 days'" },
                        notes: { type: "string", description: "Construction details worth keeping: overlay, glides, hinges..." },
                    },
                    required: ["kind", "name", "hex"],
                },
            },
            products: {
                type: "array",
                description:
                    "Individually SIZED purchasable items (a 36in sink base, a specific vanity, an appliance). Only include entries with usable dimensions.",
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        vendor: { type: "string" },
                        sku: { type: "string" },
                        category: { type: "string", enum: [...CATEGORY_ORDER] },
                        mesh: { type: "string", enum: MESH_KEYS, description: "The closest 3D recipe for this product" },
                        widthIn: { type: "number" },
                        depthIn: { type: "number" },
                        heightIn: { type: "number" },
                        mount: { type: "string", enum: ["floor", "wall", "ceiling", "counter"] },
                        elevationIn: { type: "number", description: "Bottom height above floor for wall-mounted items" },
                        price: { type: "number", description: "Price in dollars if stated" },
                        notes: { type: "string" },
                    },
                    required: ["name", "category", "mesh", "widthIn", "depthIn", "heightIn"],
                },
            },
        },
        required: ["finishes", "products"],
    },
};

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const caller = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!caller || !["ADMIN", "MANAGER"].includes(caller.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    let body: { text?: string; vendor?: string; hint?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 40) {
        return NextResponse.json({ error: "Paste at least a few lines of catalog text" }, { status: 400 });
    }
    const clipped = text.slice(0, 250_000);

    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 16_000,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: "save_catalog_entries" },
        messages: [
            {
                role: "user",
                content:
                    `Extract a product library from this remodeling vendor catalog text.\n` +
                    `Vendor (if not stated in the text): ${body.vendor ?? "unknown"}\n` +
                    `${body.hint ? `Hint from the user: ${body.hint}\n` : ""}` +
                    `Rules:\n` +
                    `- Cabinet DOOR STYLES / color lines => finishes with kind "cabinet".\n` +
                    `- Paint colors => kind "paint"; flooring lines => "floor"; countertop materials => "counter"; tile => "tile".\n` +
                    `- Only emit a product when real dimensions are present; pick the closest mesh recipe.\n` +
                    `- Estimate hex colors from names/descriptions conservatively (shaker whites ~#EDEAE6, greys ~#ADB0B0, navy ~#32405A, espresso ~#41312A, natural wood ~#C19A64).\n` +
                    `- De-duplicate. Keep names exactly as printed.\n\n` +
                    `CATALOG TEXT:\n${clipped}`,
            },
        ],
    });

    const toolUse = msg.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
        return NextResponse.json({ error: "Extraction produced no structured output" }, { status: 502 });
    }
    const input = toolUse.input as { finishes?: unknown[]; products?: unknown[] };
    return NextResponse.json({
        finishes: Array.isArray(input.finishes) ? input.finishes.slice(0, 300) : [],
        products: Array.isArray(input.products) ? input.products.slice(0, 300) : [],
        model: msg.model,
        usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
    });
}
