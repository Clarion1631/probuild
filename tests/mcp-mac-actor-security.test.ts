import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (...segments: string[]) => readFileSync(path.join(root, ...segments), "utf8");

test("Mac AI has a disabled non-human attribution account", () => {
    const actorSource = read("src", "lib", "mcp-actor.ts");
    const seedSource = read("scripts", "seed-mac-ai-user.mjs");

    assert.match(actorSource, /"mac-ai":\s*"mac-ai@goldentouchremodeling\.com"/);
    assert.match(seedSource, /email:\s*MAC_AI_EMAIL/);
    assert.match(seedSource, /status:\s*"DISABLED"/);
});

test("Mac has its own secret and cannot send or create customer documents", () => {
    const routeSource = read("src", "app", "api", "mcp", "[transport]", "route.ts");
    const actionSource = read("src", "lib", "actions.ts");

    assert.match(routeSource, /actorLabel === "mac-ai" \? process\.env\.MCP_SECRET_MAC/);
    assert.match(routeSource, /actor\.actorLabel === "mac-ai" && SEND_TOOLS\.has\(name\)/);
    assert.match(routeSource, /actor\.actorLabel === "mac-ai" && new Set\(\["create_estimate", "create_change_order", "create_contract", "bill_change_order"\]\)\.has\(name\)/);
    assert.match(actionSource, /\["mac-ai", process\.env\.MCP_SECRET_MAC\]/);
});