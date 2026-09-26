/**
 * Static check that every Speed-to-Lead Server Action in src/lib/actions.ts
 * is a THIN WRAPPER (spec Release "Fingerprint": "Server Action wrappers only
 * delegate, which a static test checks").
 *
 * "Thin" here means, for each named export below: no loops, no nested
 * function declarations, and at least one call to a `stl*`-prefixed import
 * (this file's own naming convention for "the real work lives in
 * src/lib/speed-to-lead/**") — never raw business logic (triage math, hash
 * computation, lock ordering, etc.) written inline in actions.ts itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ACTIONS_PATH = path.join(__dirname, "..", "src", "lib", "actions.ts");
const source = readFileSync(ACTIONS_PATH, "utf8");
const sourceFile = ts.createSourceFile(ACTIONS_PATH, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

const SPEED_TO_LEAD_ACTIONS = [
    "approveOutreachMessageAction",
    "saveOutreachDraftAction",
    "sendAgainOutreachMessageAction",
    "markOutreachLeadBookedAction",
    "markOutreachLeadCalledAction",
    "promoteLeadToRealAction",
    "markLeadJunkAction",
    "clearOutreachSuppressionAction",
    "saveOutreachTemplateAction",
    "approveOutreachTemplateAction",
    "revokeOutreachTemplateAction",
    "setSpeedToLeadPausedAction",
    "runSpeedToLeadReadinessAction",
    "activateSpeedToLeadLiveAction",
];

function findExportedFunction(name: string): ts.FunctionDeclaration | undefined {
    let found: ts.FunctionDeclaration | undefined;
    sourceFile.forEachChild(node => {
        if (found) return;
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
            const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
            if (isExported) found = node;
        }
    });
    return found;
}

function containsLoopOrNestedFunction(node: ts.Node): boolean {
    let bad = false;
    const visit = (n: ts.Node) => {
        if (bad) return;
        if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) bad = true;
        if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) bad = true;
        n.forEachChild(visit);
    };
    node.forEachChild(visit);
    return bad;
}

function callsADelegate(node: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isCallExpression(n)) {
            const callee = n.expression;
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) ? callee.name.text : "";
            if (name.startsWith("stl")) found = true;
        }
        n.forEachChild(visit);
    };
    node.forEachChild(visit);
    return found;
}

test("every listed name is actually an exported async function in actions.ts", () => {
    for (const name of SPEED_TO_LEAD_ACTIONS) {
        const fn = findExportedFunction(name);
        assert.ok(fn, `${name} was not found as an exported function declaration`);
        assert.ok(fn!.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword), `${name} must be async ("use server" files may only export async functions)`);
    }
});

test("every Speed-to-Lead Server Action delegates: no loops/nested functions, and calls at least one stl* helper", () => {
    for (const name of SPEED_TO_LEAD_ACTIONS) {
        const fn = findExportedFunction(name);
        if (!fn?.body) continue;
        assert.equal(containsLoopOrNestedFunction(fn.body), false, `${name} contains a loop or a nested function — business logic belongs in src/lib/speed-to-lead/**, not actions.ts`);
        assert.equal(callsADelegate(fn.body), true, `${name} never calls a stl*-prefixed delegate — it must not implement Speed-to-Lead logic inline`);
    }
});

test("every Speed-to-Lead action name in this list is unique (no duplicate declarations)", () => {
    const seen = new Set<string>();
    for (const name of SPEED_TO_LEAD_ACTIONS) {
        assert.equal(seen.has(name), false, `${name} listed twice in this test`);
        seen.add(name);
    }
});
