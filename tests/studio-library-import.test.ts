import test from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { EXTRACT_TOOL, buildImportRequest, findToolInput } from "../src/lib/studio-library-import";

test("import request never forces a tool: auto + strict tool + explicit prompt instruction", () => {
    const req = buildImportRequest({ text: "Aspen White Shaker door style, 36in sink base", vendor: "Acme", hint: "cabinets" });
    assert.equal(req.model, "claude-sonnet-5-5");
    assert.deepEqual(req.tool_choice, { type: "auto" });
    assert.deepEqual(req.output_config, { effort: "high" });
    assert.equal(req.tools?.length, 1);
    const tool = req.tools![0] as { name: string; strict?: boolean };
    assert.equal(tool.name, "save_catalog_entries");
    assert.equal(tool.strict, true);
    const prompt = String((req.messages[0] as { content: string }).content);
    assert.ok(prompt.includes("MUST respond by calling the save_catalog_entries tool"));
    assert.ok(prompt.includes("Vendor (if not stated in the text): Acme"));
    assert.ok(prompt.includes("Hint from the user: cabinets"));
    assert.ok(prompt.endsWith("CATALOG TEXT:\nAspen White Shaker door style, 36in sink base"));
});

test("import request omits thinking, sampling params and forced tool_choice (all 400 on Sonnet 5.5)", () => {
    const req = buildImportRequest({ text: "x".repeat(50) }) as unknown as Record<string, unknown>;
    for (const key of ["thinking", "temperature", "top_p", "top_k"]) assert.ok(!(key in req), key);
    assert.notEqual((req.tool_choice as { type: string }).type, "tool");
    assert.notEqual((req.tool_choice as { type: string }).type, "any");
    assert.ok(String((buildImportRequest({ text: "x".repeat(50) }).messages[0] as { content: string }).content).includes("Vendor (if not stated in the text): unknown"));
});

test("every object in the strict tool schema forbids additional properties", () => {
    const schema = EXTRACT_TOOL.input_schema as unknown as Record<string, unknown>;
    const objects: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        if (n.type === "object") objects.push(n);
        Object.values(n).forEach(walk);
    };
    walk(schema);
    assert.equal(objects.length, 3);
    for (const o of objects) assert.equal(o.additionalProperties, false);
});

test("findToolInput picks the tool_use block by type, past thinking/text blocks", () => {
    const content = [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "ok", citations: null },
        { type: "tool_use", id: "tu", name: "save_catalog_entries", input: { finishes: [{ name: "a" }], products: [] } },
    ] as ContentBlock[];
    assert.deepEqual(findToolInput(content), { finishes: [{ name: "a" }], products: [] });
});

test("findToolInput returns null when the model answered in text or called another tool", () => {
    assert.equal(findToolInput([{ type: "text", text: "sorry", citations: null }] as ContentBlock[]), null);
    assert.equal(findToolInput([{ type: "tool_use", id: "tu", name: "other", input: {} }] as ContentBlock[]), null);
});
