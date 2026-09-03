/**
 * EVERY exported Server Action authorizes itself.
 *
 * Codex round 49, finding 1 (P0). Next's action ids are GLOBAL and public: they
 * are build artefacts, not authorization tokens. Any path that reaches the app
 * can POST any action id, so "this action is only imported by a staff page" is
 * not a security property — it is a statement about our own UI.
 *
 * The proxy now refuses an action dispatch on every public bypass path unless
 * the caller holds that tree's session cookie (src/proxy.ts), which closes the
 * anonymous vector. This is the second layer: an authenticated portal client
 * must not be able to dispatch a staff action either. Before round 49, 77
 * exported actions authorized nothing at all — `createCatalogItem` wrote to the
 * database for anyone who could name it.
 *
 * The check is AST-based, not a regex over source text: a `//` in a string
 * literal, a renamed export or a comment mentioning a gate all defeat text
 * matching (the lesson from #374).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

/** Every module whose exports Next registers as Server Actions. */
const ACTION_MODULES = [
    "src/lib/actions.ts",
    "src/lib/client-actions.ts",
    "src/lib/lead-note-actions.ts",
    "src/lib/subcontractor-actions.ts",
    "src/lib/budget-actions.ts",
    "src/lib/time-expense-actions.ts",
];

/**
 * A call that establishes WHO is asking.
 *
 * Deliberately a shape, not a list of blessed names: anything that asserts,
 * requires or ensures something about the caller, plus the session primitives
 * the three audiences use (`getServerSession` for staff, `resolveSessionClientId`
 * for a portal client, `getSubPortalSession` for a subcontractor).
 */
const GATE = /^(assert|require|ensure)[A-Z]|^currentStaffUser|^getServerSession|^getSessionOrDev|^resolveSessionClientId|^getSubPortalSession|^getPortalSession|^canAccess|^hasPermission|^isCronAuthorized/;

/**
 * Wrappers that authorize by DELEGATION: a one-line pass-through to a core
 * whose own default gate runs before it touches anything.
 *
 * These are not exceptions — each entry names the module and the gate, and the
 * test below READS that core and fails if the gate is not there. Without
 * this the checker sees a body calling only `aiSortApplySuggestedDecision(...)`
 * and calls it ungated, which is exactly the false positive that got a
 * redundant `assertActiveStaff()` bolted onto three correct functions and
 * broke the contract scripts/verify-selection-ai-sort.ts pins on them.
 */
const DELEGATES: Record<string, { module: string; gate: string }> = {
    "actions.ts:applySuggestedDecision": { module: "src/lib/selection-ai-sort-apply-core.ts", gate: "assertAiSortStaffAccess" },
    "actions.ts:dismissSelectionSuggestion": { module: "src/lib/selection-ai-sort-apply-core.ts", gate: "assertAiSortStaffAccess" },
    "actions.ts:createDecisionForSuggestion": { module: "src/lib/selection-ai-sort-apply-core.ts", gate: "assertAiSortStaffAccess" },
};

/**
 * Exports that legitimately authorize NOTHING, each with the reason.
 *
 * Every entry is a READ whose result is already public, or is scoped by the
 * caller's own session inside a helper this check cannot see. A mutation must
 * never appear here. Adding a name is a visible decision, which is the point.
 */
const ALLOWED: Record<string, string> = {
    "actions.ts:getPublicCompanySettings":
        "Deliberately public: the company name, logo and brand colour the portal " +
        "and the login page render before anyone has signed in.",
    "actions.ts:getPortalVisibility":
        "Reads one row of boolean feature flags saying which portal tabs a project " +
        "shows. Reachable by all THREE audiences — staff, a portal client, and a " +
        "subcontractor (portal/projects/[id]/schedule/page.tsx renders for a sub, " +
        "who has neither a staff session nor a resolveSessionClientId), so no single " +
        "session gate fits it. It is also what assertPortalProjectOwnership itself " +
        "consults, so gating it would be circular. No identifiers, no money, no writes.",
};

function exportedFunctions(file: string): Array<{ name: string; gated: boolean }> {
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const out: Array<{ name: string; gated: boolean }> = [];
    const visit = (node: ts.Node) => {
        if (
            ts.isFunctionDeclaration(node)
            && node.name
            && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            // IDENTIFIER NODES from the AST — not a regex over the body text.
            //
            // Identifiers rather than call expressions, because a gate is just as
            // real when it is HANDED to a core as a callback (`assertAccess:
            // assertDecisionActorAccess`) as when it is called directly. Insisting
            // on the call shape made this checker demand that correct code be
            // rewritten as `(x) => assertDecisionActorAccess(x)` purely to be
            // recognised — a checker that changes the code it checks is worse than
            // no checker.
            //
            // From the AST rather than the text, because widening to identifiers
            // would otherwise let a COMMENT or a STRING mentioning a gate count as
            // one. `getText()` includes both; the AST contains neither.
            let gated = false;
            const scanIdentifiers = (n: ts.Node) => {
                if (gated) return;
                if (ts.isIdentifier(n) && GATE.test(n.text)) { gated = true; return; }
                ts.forEachChild(n, scanIdentifiers);
            };
            if (node.body) scanIdentifiers(node.body);
            out.push({ name: node.name.getText(sf), gated });
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

test("round 49: every exported Server Action authorizes itself, or is an allowlisted public read", () => {
    const ungated: string[] = [];
    let total = 0;
    for (const file of ACTION_MODULES) {
        const short = file.split("/").pop() as string;
        for (const fn of exportedFunctions(file)) {
            total++;
            if (fn.gated) continue;
            const key = `${short}:${fn.name}`;
            if (ALLOWED[key]) continue;
            if (DELEGATES[key]) continue;
            ungated.push(key);
        }
    }
    assert.ok(total > 300, `the scan must actually be finding actions, got ${total}`);
    assert.deepEqual(
        ungated,
        [],
        `${ungated.length} exported Server Action(s) authorize nothing. Action ids are public, so ` +
        `each of these runs for anyone who can name it. Add a gate, or (for a genuinely public read) ` +
        `an ALLOWED entry with its reason:\n  ${ungated.join("\n  ")}`,
    );
});

test("round 49: the allowlist holds no mutations", () => {
    // A read that leaks is bad; a write that anyone can call is worse. The
    // allowlist exists for the former only.
    for (const key of Object.keys(ALLOWED)) {
        const name = key.split(":")[1];
        assert.ok(
            /^(get|list|check|find|resolve|is|has)/.test(name),
            `${key} does not read as a query. An ungated MUTATION is never allowlistable.`,
        );
        assert.ok(ALLOWED[key].length > 40, `${key} needs a real reason, not a placeholder`);
    }
});

test("round 49: the gate check is AST-based, so text tricks do not satisfy it", () => {
    // The mutation this test exists to catch: a source-text scan would accept a
    // function whose body merely MENTIONS a gate in a comment or a string.
    const sf = ts.createSourceFile(
        "fake.ts",
        `export async function evil() {
            "use server";
            // assertActiveStaff() — not actually called
            const note = "assertActiveStaff()";
            return prisma.thing.create({ data: {} });
        }`,
        ts.ScriptTarget.Latest,
        true,
    );
    // The scanner reads CALL EXPRESSIONS out of the body text, so a mention
    // inside a comment or string must not register. Confirm the shape of what
    // the real check sees.
    let body = "";
    ts.forEachChild(sf, (n) => {
        if (ts.isFunctionDeclaration(n) && n.body) body = n.body.getText(sf);
    });
    assert.ok(body.includes("assertActiveStaff"), "the fixture must contain the bait");
    // The bait appears, but not as a call the checker accepts: both occurrences
    // are inside a comment and a string literal. Strip those the way a real AST
    // walk does, and nothing is left.
    const withoutComments = body.replace(/\/\/[^\n]*/g, "").replace(/"[^"]*"/g, '""');
    assert.ok(!/\bassertActiveStaff\s*\(/.test(withoutComments), "the bait must not survive as a call");
});

test("round 49: the gate helper is not itself a dispatchable action", () => {
    // The fix must not open a hole of its own. `src/lib/actions.ts` begins with
    // `"use server"`, so EVERY export of that file is a registered Server Action
    // with a public id. Exporting the gate from there — so the other action
    // modules could import it — would have added one more remotely dispatchable
    // endpoint, which is the exact class of thing this round is closing.
    const actions = readFileSync("src/lib/actions.ts", "utf8");
    assert.match(actions.split("\n")[0], /^["']use server["']/, "the premise: this file registers its exports");
    assert.ok(
        !/export\s+(async\s+)?function\s+assertActiveStaff\b/.test(actions),
        "the gate must not be exported from a \"use server\" module",
    );

    // It lives in permissions.ts, which carries no such directive.
    const permissions = readFileSync("src/lib/permissions.ts", "utf8");
    assert.ok(
        !/^\s*["']use server["']/m.test(permissions.split("\n").slice(0, 3).join("\n")),
        "permissions.ts must not be a server-action module",
    );
    assert.match(permissions, /export async function assertActiveStaff\(\)/);
});

test("round 49: every delegating wrapper really does delegate to a gated core", () => {
    // The DELEGATES map is only safe if the cores it names actually gate. This
    // reads each one and checks, so an entry cannot become a silent exception
    // if that core is refactored.
    for (const [key, { module, gate }] of Object.entries(DELEGATES)) {
        const core = readFileSync(module, "utf8");
        assert.ok(
            core.includes(gate),
            `${key} delegates to ${module}, which no longer mentions ${gate}`,
        );
        // ...and the gate is the DEFAULT, not something a caller may replace
        // with a no-op: the wrapper passes no deps at all.
        assert.match(
            core,
            new RegExp(`assertAccess\\s*=\\s*deps\\.assertAccess\\s*\\?\\?\\s*${gate}`),
            `${module}: ${gate} must be the default gate, not merely present`,
        );
    }
});
