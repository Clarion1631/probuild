// Request builder for /api/studio-library/import (AI extraction of finishes /
// products from pasted catalog text). Lives outside the route file so the
// request shape can be unit-tested.
//
// Sonnet 5.5 rejects a forced `tool_choice` ({type:"tool"|"any"} is a 400), so
// the tool is offered with `tool_choice: auto`, `strict: true` (schema-valid
// arguments) and a prompt instruction to call it. `auto` does not guarantee a
// call, so the route checks for one and retries.

import type Anthropic from "@anthropic-ai/sdk";
import { MESH_KEYS, CATEGORY_ORDER } from "./studio/catalog";
import { CLAUDE_SONNET_MODEL } from "./anthropic";

export const EXTRACT_TOOL = {
    name: "save_catalog_entries",
    description: "Save the finishes and products extracted from the vendor catalog text.",
    input_schema: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
            finishes: {
                type: "array",
                description:
                    "Color/material LINES (cabinet door styles, paint colors, flooring lines, countertop materials, tile lines). Use for entries that describe a look, not a sized object.",
                items: {
                    type: "object",
                    additionalProperties: false,
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
                    additionalProperties: false,
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

export interface ImportToolInput {
    finishes?: unknown[];
    products?: unknown[];
}

export function buildImportRequest(args: {
    text: string;
    vendor?: string;
    hint?: string;
}): Anthropic.MessageCreateParamsNonStreaming {
    return {
        model: CLAUDE_SONNET_MODEL,
        // Thinking (adaptive on 5.5) counts against this cap; extraction is a
        // low-effort task but the tool payload can be long.
        max_tokens: 16_000,
        output_config: { effort: "high" },
        tools: [{ ...EXTRACT_TOOL, strict: true }],
        tool_choice: { type: "auto" },
        messages: [
            {
                role: "user",
                content:
                    `Extract a product library from this remodeling vendor catalog text.
` +
                    `You MUST respond by calling the ${EXTRACT_TOOL.name} tool exactly once with everything you extracted. Do not answer in plain text.
` +
                    `Vendor (if not stated in the text): ${args.vendor ?? "unknown"}
` +
                    `${args.hint ? `Hint from the user: ${args.hint}
` : ""}` +
                    `Rules:
` +
                    `- Cabinet DOOR STYLES / color lines => finishes with kind "cabinet".
` +
                    `- Paint colors => kind "paint"; flooring lines => "floor"; countertop materials => "counter"; tile => "tile".
` +
                    `- Only emit a product when real dimensions are present; pick the closest mesh recipe.
` +
                    `- Estimate hex colors from names/descriptions conservatively (shaker whites ~#EDEAE6, greys ~#ADB0B0, navy ~#32405A, espresso ~#41312A, natural wood ~#C19A64).
` +
                    `- De-duplicate. Keep names exactly as printed.

` +
                    `CATALOG TEXT:
${args.text}`,
            },
        ],
    };
}

/** The extraction tool call's input, found by block type (a response can also
 * carry thinking / text blocks), or null when the model did not call it. */
export function findToolInput(content: Anthropic.ContentBlock[]): ImportToolInput | null {
    const block = content.find((c) => c.type === "tool_use" && c.name === EXTRACT_TOOL.name);
    if (!block || block.type !== "tool_use") return null;
    return block.input as ImportToolInput;
}
