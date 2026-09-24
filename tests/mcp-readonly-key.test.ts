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
 * 1. `resolveMcpActorLabel` and `secretForActor` ARE exported and have no
 *    such dependency — those tests call them directly, with real env vars,
 *    for real behavior.
 * 2. `wrapReadOnlyMode` and `wrapWriteTools` are ALSO exported (testing-only —
 *    see the "exported for testing only" comment at each declaration) and
 *    exercised against a stub `registerTool` that just records what got
 *    registered, in the same composition order `createHandler` uses in
 *    route.ts. This proves actual registration behavior, not just source
 *    shape: every READONLY_TOOLS name gets registered for readonly-ai,
 *    representative write tools never do, and their callbacks never run.
 * 3. READONLY_TOOLS / WRITE_TOOLS are exported Sets, so the allowlist and the
 *    no-write-tool-slipped-in check are real Set operations, not regex.
 * 4. What's left as source-pattern checks is only what genuinely can't be
 *    observed otherwise without executing the other ~50 registerTool calls
 *    (which need a live DB): that every allowlisted tool's OWN definition
 *    carries `readOnlyHint: true`, and that wrapReadOnlyMode runs before the
 *    first registerTool call inside createHandler's real initializer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
    resolveMcpActorLabel,
    secretForActor,
    wrapReadOnlyMode,
    wrapWriteTools,
    READONLY_TOOLS,
    WRITE_TOOLS,
} from "../src/app/api/mcp/[transport]/route";

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

test("an empty-string MCP_READONLY_SECRET also disables read-only mode — no key can resolve to readonly-ai", () => {
    withEnv({ MCP_SECRET: "full-secret", MCP_SECRET_RICHARD: undefined, MCP_READONLY_SECRET: "" }, () => {
        assert.equal(resolveMcpActorLabel(reqWithKey("")), null);
        assert.equal(resolveMcpActorLabel(reqWithKey("full-secret")), "justin-ai");
    });
});

test("MCP_READONLY_SECRET colliding with MCP_SECRET resolves to NO actor at all (fails closed)", () => {
    withEnv({ MCP_SECRET: "shared-secret", MCP_SECRET_RICHARD: "richard-secret", MCP_READONLY_SECRET: "shared-secret" }, () => {
        // Neither justin-ai nor readonly-ai — the shared value is refused outright.
        assert.equal(resolveMcpActorLabel(reqWithKey("shared-secret")), null);
        // Richard's genuinely distinct secret is unaffected by the misconfiguration.
        assert.equal(resolveMcpActorLabel(reqWithKey("richard-secret")), "richard-ai");
    });
});

test("MCP_READONLY_SECRET colliding with MCP_SECRET_RICHARD resolves to NO actor at all (fails closed)", () => {
    withEnv({ MCP_SECRET: "full-secret", MCP_SECRET_RICHARD: "shared-secret", MCP_READONLY_SECRET: "shared-secret" }, () => {
        assert.equal(resolveMcpActorLabel(reqWithKey("shared-secret")), null);
        // Justin's genuinely distinct secret is unaffected by the misconfiguration.
        assert.equal(resolveMcpActorLabel(reqWithKey("full-secret")), "justin-ai");
    });
});

// ── secretForActor ───────────────────────────────────────────────────────────

test('secretForActor("readonly-ai") never falls through to MCP_SECRET', () => {
    withEnv({ MCP_SECRET: "full-secret", MCP_SECRET_RICHARD: "richard-secret" }, () => {
        assert.throws(() => secretForActor("readonly-ai"));
        // Sanity: the other two actors are untouched by the readonly-ai guard.
        assert.equal(secretForActor("justin-ai"), "full-secret");
        assert.equal(secretForActor("richard-ai"), "richard-secret");
    });
});

// ── wrapReadOnlyMode / wrapWriteTools: real behavior against a stub server ──

type StubActor = {
    actorLabel: "justin-ai" | "richard-ai" | "readonly-ai";
    resolveActorUserId: () => Promise<string | null>;
    resolveOnBehalfOf: () => Promise<{ id: string; name: string } | null>;
};

function stubActor(actorLabel: StubActor["actorLabel"]): StubActor {
    return {
        actorLabel,
        resolveActorUserId: async () => null,
        resolveOnBehalfOf: async () => null,
    };
}

function makeStubServer() {
    const registered = new Map<string, (...cbArgs: unknown[]) => unknown>();
    const server = {
        registerTool: (name: string, _config: unknown, cb: (...cbArgs: unknown[]) => unknown) => {
            registered.set(name, cb);
            return { name };
        },
    };
    return { server, registered };
}

// Representative write tools — deliberately NOT in READONLY_TOOLS — covering
// a plain write (create_change_order), a customer-facing send
// (send_milestone_invoice), and a money-logging write (log_expense).
const REPRESENTATIVE_WRITE_TOOLS = ["create_change_order", "send_milestone_invoice", "log_expense"];
for (const name of REPRESENTATIVE_WRITE_TOOLS) {
    assert.ok(WRITE_TOOLS.has(name), `test setup: "${name}" is expected to be a real WRITE_TOOLS entry`);
    assert.ok(!READONLY_TOOLS.has(name), `test setup: "${name}" is expected to be absent from READONLY_TOOLS`);
}

test("wrapReadOnlyMode registers every READONLY_TOOLS name for readonly-ai, and blocks write tools' registration and callbacks", () => {
    const { server, registered } = makeStubServer();
    wrapReadOnlyMode(server, stubActor("readonly-ai"));

    let anyBlockedCallbackRan = false;
    for (const name of READONLY_TOOLS) {
        server.registerTool(name, {}, () => `${name}-ran`);
    }
    for (const name of REPRESENTATIVE_WRITE_TOOLS) {
        server.registerTool(name, {}, () => { anyBlockedCallbackRan = true; return "should never run"; });
    }

    for (const name of READONLY_TOOLS) {
        assert.ok(registered.has(name), `"${name}" should be registered for readonly-ai`);
    }
    for (const name of REPRESENTATIVE_WRITE_TOOLS) {
        assert.ok(!registered.has(name), `"${name}" must NOT be registered for readonly-ai`);
    }
    // Nothing calls a callback that was never registered — nothing to invoke.
    assert.equal(anyBlockedCallbackRan, false);
});

test("wrapReadOnlyMode is a no-op for justin-ai / richard-ai — every tool (read and write) registers normally", () => {
    for (const actorLabel of ["justin-ai", "richard-ai"] as const) {
        const { server, registered } = makeStubServer();
        wrapReadOnlyMode(server, stubActor(actorLabel));
        for (const name of [...READONLY_TOOLS, ...REPRESENTATIVE_WRITE_TOOLS]) {
            server.registerTool(name, {}, () => `${name}-ran`);
        }
        for (const name of [...READONLY_TOOLS, ...REPRESENTATIVE_WRITE_TOOLS]) {
            assert.ok(registered.has(name), `"${name}" should register normally for ${actorLabel}`);
        }
    }
});

test("wrapReadOnlyMode composed with wrapWriteTools, in the exact order createHandler uses, still fully blocks write tools for readonly-ai", () => {
    const { server, registered } = makeStubServer();
    const actor = stubActor("readonly-ai");
    // Same order as createHandler's initializer in route.ts:
    //   wrapReadOnlyMode(server, actor); wrapWriteTools(server, actor);
    wrapReadOnlyMode(server, actor);
    wrapWriteTools(server, actor);

    for (const name of READONLY_TOOLS) server.registerTool(name, {}, () => `${name}-ran`);
    for (const name of WRITE_TOOLS) server.registerTool(name, {}, () => "should never run");

    for (const name of READONLY_TOOLS) {
        assert.ok(registered.has(name), `"${name}" should still be registered for readonly-ai after composing with wrapWriteTools`);
    }
    for (const name of WRITE_TOOLS) {
        assert.ok(!registered.has(name), `"${name}" must not be registered for readonly-ai even after composing with wrapWriteTools`);
    }
});

test("wrapReadOnlyMode composed with wrapWriteTools, same order, registers every tool for justin-ai (full access unaffected)", () => {
    const { server, registered } = makeStubServer();
    const actor = stubActor("justin-ai");
    wrapReadOnlyMode(server, actor);
    wrapWriteTools(server, actor);

    for (const name of READONLY_TOOLS) server.registerTool(name, {}, () => `${name}-ran`);
    for (const name of WRITE_TOOLS) server.registerTool(name, {}, () => `${name}-ran`);

    for (const name of [...READONLY_TOOLS, ...WRITE_TOOLS]) {
        assert.ok(registered.has(name), `"${name}" should register normally for justin-ai`);
    }
});

// ── Allowlist composition (real Sets, not regex) ────────────────────────────

test("READONLY_TOOLS is exactly the expected 20-tool allowlist (snapshot — a new tool needs a deliberate change here)", () => {
    const expected = new Set([
        "list_projects", "list_leads", "find_job", "get_estimating_codes",
        "list_templates", "get_template", "get_estimate",
        "list_project_billing", "list_receivables", "list_change_orders",
        "list_daily_logs", "list_inspections", "list_punch_items", "get_project_contacts",
        "list_contract_templates", "list_contracts",
        "get_company_schedule", "get_project_schedule", "list_crew_availability",
        "get_activity_log",
    ]);
    assert.deepStrictEqual(READONLY_TOOLS, expected);
});

test("no WRITE_TOOLS entry is in READONLY_TOOLS", () => {
    for (const name of WRITE_TOOLS) {
        assert.ok(!READONLY_TOOLS.has(name), `"${name}" is a write tool (in WRITE_TOOLS) but was also allowlisted for read-only mode`);
    }
});

test("the document-content / URL-returning tools stay out of READONLY_TOOLS", () => {
    for (const name of ["list_project_files", "read_file", "get_file_link", "get_contract"]) {
        assert.ok(!READONLY_TOOLS.has(name), `"${name}" must not be in READONLY_TOOLS`);
    }
});

// ── What's left as source-pattern checks (see file header for why) ─────────

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

test("every tool in READONLY_TOOLS is registered with readOnlyHint: true in its own definition", () => {
    const annotations = toolAnnotations();
    for (const name of READONLY_TOOLS) {
        const anno = annotations.get(name);
        assert.ok(anno !== undefined, `READONLY_TOOLS lists "${name}" but no such tool is registered`);
        assert.match(anno!, /readOnlyHint:\s*true/, `"${name}" is in READONLY_TOOLS but its own annotations don't say readOnlyHint: true`);
    }
});

test("every currently registered tool not in READONLY_TOOLS is absent from the read-only allowlist by default (new tools default to hidden)", () => {
    const annotations = toolAnnotations();
    // Anything registered without readOnlyHint: true must not be allowlisted —
    // covers every current write tool, not just the ones in WRITE_TOOLS.
    for (const [name, anno] of annotations) {
        if (READONLY_TOOLS.has(name)) {
            assert.match(anno, /readOnlyHint:\s*true/, `"${name}" is allowlisted without being annotated readOnlyHint: true`);
        }
    }
});

test("createHandler's initializer calls wrapReadOnlyMode before wrapWriteTools, before the first registerTool call", () => {
    const handlerMatch = routeSource.match(/function createHandler\(actor: RouteMcpActor\) \{[\s\S]*?server => \{([\s\S]*?)server\.registerTool\(/);
    assert.ok(handlerMatch, "createHandler's server initializer not found");
    const preamble = handlerMatch![1];
    assert.match(preamble, /wrapReadOnlyMode\(server, actor\)/, "wrapReadOnlyMode must run before the first registerTool call");
    assert.match(preamble, /wrapWriteTools\(server, actor\)/, "wrapWriteTools must run before the first registerTool call");
    const readOnlyAt = preamble.indexOf("wrapReadOnlyMode(server, actor)");
    const writeToolsAt = preamble.indexOf("wrapWriteTools(server, actor)");
    assert.ok(readOnlyAt < writeToolsAt, "wrapReadOnlyMode must be applied before wrapWriteTools, matching the composition tested above");
});

test("MCP_SECRET / MCP_SECRET_RICHARD behavior is untouched: guarded() only 503s when ALL THREE secrets are unset", () => {
    assert.match(
        routeSource,
        /if \(!process\.env\.MCP_SECRET && !process\.env\.MCP_SECRET_RICHARD && !process\.env\.MCP_READONLY_SECRET\)/,
        "the 'not configured' gate must treat a read-only-only deployment as configured",
    );
});
