/**
 * MCP_READONLY_SECRET — a second key for /api/mcp/mcp that can only ever
 * reach READ tools (no create/update/delete/send/email/QuickBooks-push).
 *
 * Two layers, tested separately for the same reason
 * tests/mcp-log-expense-attribution.test.ts gives: the per-tool handlers are
 * closures registered inline via `server.registerTool(...)` inside a
 * 2,800+ line route file with no exported per-tool entry point, and
 * `createHandler` builds a real `mcp-handler` McpServer (Streamable HTTP,
 * session/transport machinery) that isn't safe to exercise end-to-end from a
 * plain `node:test` run without a live DB and a real MCP client. So:
 *
 * 1. `resolveMcpActorLabel` IS exported and has no such dependency — those
 *    tests actually call it, with real env vars, for real behavior.
 * 2. The tool-gating logic (READONLY_TOOLS + wrapReadOnlyMode, both file-
 *    private) is pinned with source-pattern checks against the route file
 *    text, the same technique the log_expense test already uses. This
 *    proves the allowlist is a hardcoded, non-empty set of tools that are
 *    ALL registered with `readOnlyHint: true` in their own definition (i.e.
 *    every allowlisted tool really is a read, per the file's own
 *    annotations), that no WRITE_TOOLS entry (other than the two read-only
 *    content-access tools) ever slips into that allowlist, and that the
 *    gate runs ahead of tool registration and is a no-op for the existing
 *    justin-ai / richard-ai keys.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveMcpActorLabel } from "../src/app/api/mcp/[transport]/route";

const routeSource = readFileSync(
    path.join(__dirname, "..", "src", "app", "api", "mcp", "[transport]", "route.ts"),
    "utf8",
);

function withEnv(env: Record<string, string | undefined>, run: () => void) {
    const previous: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) previous[key] = process.env[key];
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        run();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function reqWithKey(key: string | undefined): Request {
    const url = new URL("https://probuild.test/api/mcp/mcp");
    if (key !== undefined) url.searchParams.set("key", key);
    return new Request(url);
}

// ── resolveMcpActorLabel: real behavior, real env vars ──────────────────────

test("the full key (MCP_SECRET) still resolves to justin-ai — unchanged", () => {
    withEnv({ MCP_SECRET: "full-secret", MCP_SECRET_RICHARD: undefined, MCP_READONLY_SECRET: undefined }, () => {
        assert.equal(resolveMcpActorLabel(reqWithKey("full-secret")), "justin-ai");
        assert.equal(resolveMcpActorLabel(reqWithKey("wrong")), null);
        assert.equal(resolveMcpActorLabel(reqWithKey(undefined)), null);
    });
});

test("Richard's key still resolves to richard-ai — unchanged", () => {
    withEnv({ MCP_SECRET: "full-secret", MCP_SECRET_RICHARD: "richard-secret", MCP_READONLY_SECRET: undefined }, () => {
        assert.equal(resolveMcpActorLabel(reqWithKey("richard-secret")), "richard-ai");
        assert.equal(resolveMcpActorLabel(reqWithKey("full-secret")), "justin-ai");
    });
});

test("the read-only key resolves to readonly-ai when MCP_READONLY_SECRET is set", () => {
    withEnv({ MCP_SECRET: "full-secret", MCP_SECRET_RICHARD: "richard-secret", MCP_READONLY_SECRET: "readonly-secret" }, () => {
        assert.equal(resolveMcpActorLabel(reqWithKey("readonly-secret")), "readonly-ai");
        // it doesn't leak into matching the other keys, or vice versa
        assert.notEqual(resolveMcpActorLabel(reqWithKey("full-secret")), "readonly-ai");
        assert.notEqual(resolveMcpActorLabel(reqWithKey("richard-secret")), "readonly-ai");
    });
});

test("a wrong read-only key is rejected", () => {
    withEnv({ MCP_SECRET: "full-secret", MCP_SECRET_RICHARD: undefined, MCP_READONLY_SECRET: "readonly-secret" }, () => {
        assert.equal(resolveMcpActorLabel(reqWithKey("readonly-secret-but-not-quite")), null);
        assert.equal(resolveMcpActorLabel(reqWithKey("")), null);
        assert.equal(resolveMcpActorLabel(reqWithKey(undefined)), null);
    });
});

test("an unset MCP_READONLY_SECRET disables read-only mode entirely — no key can resolve to readonly-ai", () => {
    withEnv({ MCP_SECRET: "full-secret", MCP_SECRET_RICHARD: "richard-secret", MCP_READONLY_SECRET: undefined }, () => {
        // Guessing the key that would have worked, had it been configured.
        assert.equal(resolveMcpActorLabel(reqWithKey("readonly-secret")), null);
        assert.equal(resolveMcpActorLabel(reqWithKey("")), null);
        // The other two keys are completely unaffected by the absence.
        assert.equal(resolveMcpActorLabel(reqWithKey("full-secret")), "justin-ai");
        assert.equal(resolveMcpActorLabel(reqWithKey("richard-secret")), "richard-ai");
    });
});

// ── Tool-gating: source-pattern checks (see file header for why) ───────────

function extractSetLiteral(name: string): Set<string> {
    const match = routeSource.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
    assert.ok(match, `${name} definition not found`);
    const names = [...match[1].matchAll(/"([a-zA-Z_]+)"/g)].map(m => m[1]);
    assert.ok(names.length > 0, `${name} parsed to an empty set`);
    return new Set(names);
}

// name -> the annotations object literal text found inside ITS OWN
// registerTool(...) call (bounded by the next registerTool call), mirroring
// the extraction used to build the classification table in the PR/commit.
function toolAnnotations(): Map<string, string> {
    const re = /registerTool\(\s*\n?\s*"([a-zA-Z_]+)"/g;
    const starts: Array<{ name: string; index: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(routeSource)) !== null) {
        starts.push({ name: m[1], index: m.index });
    }
    assert.ok(starts.length > 40, "expected dozens of registerTool calls — extraction looks broken");
    const result = new Map<string, string>();
    for (let i = 0; i < starts.length; i++) {
        const begin = starts[i].index;
        const end = i + 1 < starts.length ? starts[i + 1].index : routeSource.length;
        const slice = routeSource.slice(begin, end);
        const anno = slice.match(/annotations:\s*\{([^}]*)\}/);
        result.set(starts[i].name, anno ? anno[1] : "");
    }
    return result;
}

test("READONLY_TOOLS is a non-empty hardcoded allowlist", () => {
    const readonlyTools = extractSetLiteral("READONLY_TOOLS");
    assert.ok(readonlyTools.size >= 20, `expected the full read surface, got ${readonlyTools.size}`);
});

test("every tool in READONLY_TOOLS is registered with readOnlyHint: true in its own definition", () => {
    const readonlyTools = extractSetLiteral("READONLY_TOOLS");
    const annotations = toolAnnotations();
    for (const name of readonlyTools) {
        const anno = annotations.get(name);
        assert.ok(anno !== undefined, `READONLY_TOOLS lists "${name}" but no such tool is registered`);
        assert.match(anno!, /readOnlyHint:\s*true/, `"${name}" is in READONLY_TOOLS but its own annotations don't say readOnlyHint: true`);
    }
});

test("no true write tool is in READONLY_TOOLS — only the two read-only content-access exceptions", () => {
    const readonlyTools = extractSetLiteral("READONLY_TOOLS");
    const writeTools = extractSetLiteral("WRITE_TOOLS");
    const auditedButReadOnly = new Set(["read_file", "get_file_link"]);
    for (const name of writeTools) {
        if (auditedButReadOnly.has(name)) continue;
        assert.ok(!readonlyTools.has(name), `"${name}" is a write tool (in WRITE_TOOLS) but was also allowlisted for read-only mode`);
    }
});

test("every currently registered tool not in READONLY_TOOLS is absent from the read-only allowlist by default (new tools default to hidden)", () => {
    const readonlyTools = extractSetLiteral("READONLY_TOOLS");
    const annotations = toolAnnotations();
    // Anything registered without readOnlyHint: true must not be allowlisted —
    // covers every current write tool, not just the ones in WRITE_TOOLS.
    for (const [name, anno] of annotations) {
        if (readonlyTools.has(name)) {
            assert.match(anno, /readOnlyHint:\s*true/, `"${name}" is allowlisted without being annotated readOnlyHint: true`);
        }
    }
});

test("wrapReadOnlyMode gates registration BEFORE any tool is registered, and is a no-op unless actorLabel is readonly-ai", () => {
    const fnAt = routeSource.indexOf("function wrapReadOnlyMode(");
    assert.ok(fnAt > -1, "wrapReadOnlyMode not found");
    const body = routeSource.slice(fnAt, fnAt + 600);
    assert.match(body, /actor\.actorLabel !== "readonly-ai"/, "must early-return for every actor except readonly-ai");
    assert.match(body, /READONLY_TOOLS\.has\(name\)/, "must check the hardcoded allowlist by tool name");
    assert.match(body, /return undefined/, "a non-allowlisted tool must simply never be registered");

    const handlerMatch = routeSource.match(/function createHandler\(actor: RouteMcpActor\) \{[\s\S]*?server => \{([\s\S]*?)server\.registerTool\(/);
    assert.ok(handlerMatch, "createHandler's server initializer not found");
    assert.match(handlerMatch![1], /wrapReadOnlyMode\(server, actor\)/, "wrapReadOnlyMode must run before the first registerTool call");
});

test("MCP_SECRET / MCP_SECRET_RICHARD behavior is untouched: guarded() only 503s when ALL THREE secrets are unset", () => {
    assert.match(
        routeSource,
        /if \(!process\.env\.MCP_SECRET && !process\.env\.MCP_SECRET_RICHARD && !process\.env\.MCP_READONLY_SECRET\)/,
        "the 'not configured' gate must treat a read-only-only deployment as configured",
    );
});
